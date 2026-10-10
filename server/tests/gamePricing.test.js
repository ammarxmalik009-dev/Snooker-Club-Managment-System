// Tests for Phase 11.3: game pricing and the rate snapshot.
//   Century       = billed minutes × the Century per-minute rate (the SAME time rule as every bill)
//   Frame         = frames × the Frame rate (unchanged)
//   Snooker Point / 4 Players = a rate per game, stored now, but the modes stay disabled
// Rates live in Settings.gameRates; old settings documents get safe defaults without a migration.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const registry = require("../config/gameModes");
const { calculateBill, billableMinutes } = require("../services/billing.calculator");

const TEST_DB_URI = process.env.MONGODB_PRICING_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_pricing";

let server;
let baseUrl;
let tableNumber = 0;
const cookies = {};

async function api(method, path, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json() };
}

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);
const setSettings = (body, cookie) => api("PATCH", "/settings", { body, cookie });
const DEFAULT_RATES = { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 };

// A finished session that lasted `seconds`
async function finishedSession(seconds) {
  tableNumber += 1;
  const table = (await api("POST", "/tables", { body: { tableNumber, hourlyRate: 1 } })).body.data;
  const session = (await api("POST", "/sessions", { body: { tableId: table.id } })).body.data;
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
  return (await api("POST", `/sessions/${session.id}/end`)).body.data;
}
const billBody = (session, extra = {}) => ({
  sessionId: session.id, gameMode: "century", quantity: 1, payerRule: "loser",
  players: [{ name: "Ali", result: "winner" }, { name: "Usman", result: "loser" }], ...extra,
});

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["admin", "staff", "cashier"]) cookies[role] = await loginAs(baseUrl, role);
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------
// Registry + pure maths
// ---------------------------------------------------------------------------

test("registry: pricing type, unit and default rate of every mode", () => {
  assert.deepEqual(registry.GAME_MODES.map((m) => [m.key, m.pricingType, m.rateUnit.one, m.defaultRate, m.enabled]), [
    ["century", "per_minute", "minute", 1000, true],
    ["frame", "per_frame", "frame", 25000, true],
    ["snooker_point", "fixed", "game", 35000, false],
    ["four_player", "fixed", "game", 50000, false],
  ]);
  assert.deepEqual([...registry.PRICING_TYPES], ["per_game", "per_minute", "per_frame", "fixed"]);
  assert.deepEqual(registry.ENABLED_GAME_MODE_KEYS, ["century", "frame"], "Snooker Point and 4 Players stay disabled");
  assert.equal(registry.gameLineDescription("century", 50, "per_minute"), "Century minutes");
  assert.equal(registry.gameLineDescription("century", 1, "per_minute"), "Century minute");
});

test("rate resolution: admin rate, else the old Frame price, else the default - never the old century price", () => {
  const rate = registry.rateFromSettings;
  // Nothing set at all (an old settings document)
  assert.deepEqual(registry.resolveGameRates({ centuryPrice: 0, framePrice: 0 }), DEFAULT_RATES);
  assert.deepEqual(registry.resolveGameRates(null), DEFAULT_RATES);
  // Old documents: framePrice keeps its meaning; centuryPrice (per game) is NOT turned into a per-minute rate
  assert.equal(rate("frame", { framePrice: 15000 }), 15000);
  assert.equal(rate("century", { centuryPrice: 30000 }), 1000);
  // Set by an admin: wins over everything, including 0 (= switched off)
  assert.equal(rate("frame", { framePrice: 15000, gameRates: { frame: 20000 } }), 20000);
  assert.equal(rate("frame", { framePrice: 15000, gameRates: { frame: 0 } }), 0);
  assert.equal(rate("century", { gameRates: { century: 1200 } }), 1200);
  assert.equal(rate("four_player", { gameRates: { four_player: 60000 } }), 60000);
  assert.equal(rate("pool", {}), null);
});

test("calculator: per minute = billed minutes × rate; quantity pricing unchanged", () => {
  const players = [{ name: "A", result: "winner" }, { name: "B", result: "loser" }];
  const century = calculateBill({ gameMode: "century", quantity: 4, unitPrice: 1000, pricingType: "per_minute", billedMinutes: 50, payerRule: "loser", players });
  assert.deepEqual(century.lineItems, [{ type: "game", description: "Century minutes", quantity: 50, unitPrice: 1000, amount: 50000 }]);
  assert.equal(century.total, 50000);
  assert.deepEqual(century.players.map((p) => p.shareAmount), [0, 50000]);
  // The number of games does not change a per-minute price
  assert.equal(calculateBill({ gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", billedMinutes: 50, payerRule: "loser", players }).total, 50000);
  // Frame: quantity × rate, exactly as before
  const frame = calculateBill({ gameMode: "frame", quantity: 3, unitPrice: 25000, pricingType: "per_frame", billedMinutes: 50, payerRule: "loser", players });
  assert.deepEqual(frame.lineItems[0], { type: "game", description: "Frames", quantity: 3, unitPrice: 25000, amount: 75000 });
  // Fixed-rate modes (priced, not yet usable for bills): quantity × rate
  assert.equal(calculateBill({ gameMode: "four_player", quantity: 1, unitPrice: 50000, pricingType: "fixed", payerRule: "split", players }).total, 50000);
  // Per minute without minutes is a programming error, never a Rs 0 line
  assert.throws(() => calculateBill({ gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", payerRule: "split", players }));
  // The time rule is the one shared function
  assert.deepEqual([7 * 60, 15 * 60 + 1, 47 * 60 + 10].map((s) => billableMinutes(s, 15, 5)), [15, 20, 50]);
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

test("settings: a new club gets the default rates; nothing is written to the old fields", async () => {
  const { status, body } = await api("GET", "/settings");
  assert.equal(status, 200);
  assert.deepEqual(body.data.gameRates, DEFAULT_RATES);
  assert.equal(body.data.centuryPrice, 0);
  assert.equal(body.data.framePrice, 0);
  const stored = await db().collection("settings").findOne({ key: "club" });
  assert.equal(stored.gameRates, undefined, "defaults come from the registry, not stored copies");
});

test("settings: an OLD settings document (no gameRates) keeps working without a migration", async () => {
  await db().collection("settings").deleteMany({});
  const old = { key: "club", centuryPrice: 30000, framePrice: 15000, minimumBillableMinutes: 15, billingIncrementMinutes: 5,
                taxEnabled: false, taxRateBasisPoints: 0, noShowGraceMinutes: 15, currency: "PKR" };
  await db().collection("settings").insertOne({ ...old });
  const { body } = await api("GET", "/settings");
  assert.deepEqual(body.data.gameRates, { ...DEFAULT_RATES, frame: 15000 }, "old Frame price kept; Century gets the per-minute default");
  assert.equal(body.data.centuryPrice, 30000, "old value preserved");
  const stored = await db().collection("settings").findOne({ key: "club" });
  assert.equal(stored.gameRates, undefined, "reading changed nothing");
  assert.equal(stored.centuryPrice, 30000);

  // A Frame bill made from this document uses the old Frame price; Century uses Rs 10/min
  const frame = (await api("POST", "/bills", { body: billBody(await finishedSession(10 * 60), { gameMode: "frame", quantity: 2 }) })).body.data;
  assert.deepEqual([frame.unitPrice, frame.total, frame.pricingType], [15000, 30000, "per_frame"]);
  const century = (await api("POST", "/bills", { body: billBody(await finishedSession(20 * 60)) })).body.data;
  assert.deepEqual([century.unitPrice, century.billedMinutes, century.total], [1000, 20, 20000]);
});

test("settings: admin sets any of the four rates; frame and the old framePrice stay in step", async () => {
  const saved = await setSettings({ gameRates: { century: 1200, snooker_point: 40000 } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.gameRates, { century: 1200, frame: 15000, snooker_point: 40000, four_player: 50000 });
  assert.equal(saved.body.data.centuryPrice, 30000, "the old century price is left alone");

  // New field -> old field
  const frame = (await setSettings({ gameRates: { frame: 26000 } })).body.data;
  assert.deepEqual([frame.gameRates.frame, frame.framePrice], [26000, 26000]);
  // Old field (older API clients) -> new field
  const legacy = (await setSettings({ framePrice: 24000 })).body.data;
  assert.deepEqual([legacy.gameRates.frame, legacy.framePrice], [24000, 24000]);
  // Both, the same: fine. Both, different: refused
  assert.equal((await setSettings({ framePrice: 25000, gameRates: { frame: 25000 } })).status, 200);
  const clash = await setSettings({ framePrice: 1, gameRates: { frame: 2 } });
  assert.equal(clash.status, 400);
  assert.equal(clash.body.message, "Send the Frame rate once (gameRates.frame, or the older framePrice)");
  // The old centuryPrice is still accepted and stored, but does not price Century any more
  const oldClient = (await setSettings({ centuryPrice: 45000 })).body.data;
  assert.deepEqual([oldClient.centuryPrice, oldClient.gameRates.century], [45000, 1200]);
  // Strings of digits are accepted like every other setting
  assert.equal((await setSettings({ gameRates: { four_player: "55000" } })).body.data.gameRates.four_player, 55000);
});

test("settings: bad rates are refused with clear messages and change nothing", async () => {
  await setSettings({ gameRates: { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 } });
  const cases = [
    [{ gameRates: { century: -1 } }, "Century rate must be between Rs 0 and Rs 100,000"],
    [{ gameRates: { century: 10.5 } }, "Century rate must be between Rs 0 and Rs 100,000"],
    [{ gameRates: { frame: "abc" } }, "Frame rate must be between Rs 0 and Rs 100,000"],
    [{ gameRates: { snooker_point: 10_000_001 } }, "Snooker Point rate must be between Rs 0 and Rs 100,000"],
    [{ gameRates: { four_player: null } }, "4 Players rate must be between Rs 0 and Rs 100,000"],
    [{ gameRates: { pool: 100 } }, "Game rates can only be set for: century, frame, snooker_point, four_player"],
    [{ gameRates: {} }, "Game rates must look like { \"century\": 1000 } (paisa)"],
    [{ gameRates: [1000] }, "Game rates must look like { \"century\": 1000 } (paisa)"],
    [{ gameRates: 1000 }, "Game rates must look like { \"century\": 1000 } (paisa)"],
  ];
  for (const [body, message] of cases) {
    const result = await setSettings(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.ok(result.body.errors.some((e) => e.message === message), `${JSON.stringify(body)} -> ${JSON.stringify(result.body.errors)}`);
  }
  assert.deepEqual((await api("GET", "/settings")).body.data.gameRates, DEFAULT_RATES, "failed updates change nothing");
});

test("settings: only an admin can change rates (staff/cashier 403, logged out 401)", async () => {
  for (const role of ["staff", "cashier"]) {
    const result = await setSettings({ gameRates: { century: 1 } }, cookies[role]);
    assert.equal(result.status, 403, role);
  }
  assert.equal((await setSettings({ gameRates: { century: 1 } }, null)).status, 401);
  assert.equal((await api("GET", "/settings")).body.data.gameRates.century, 1000);
});

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

test("century bill: billed minutes (minimum + rounding) × the per-minute rate, snapshotted", async () => {
  await setSettings({ gameRates: { century: 1000 }, minimumBillableMinutes: 15, billingIncrementMinutes: 5 });
  const cases = [[7 * 60, 15, 15000], [15 * 60 + 1, 20, 20000], [47 * 60 + 10, 50, 50000], [120 * 60, 120, 120000]];
  for (const [seconds, minutes, total] of cases) {
    const bill = (await api("POST", "/bills", { body: billBody(await finishedSession(seconds), { quantity: 2 }) })).body.data;
    assert.deepEqual([bill.billedMinutes, bill.unitPrice, bill.pricingType, bill.quantity, bill.total], [minutes, 1000, "per_minute", 2, total], `${seconds}s`);
    assert.deepEqual(bill.lineItems[0], { type: "game", description: "Century minutes", quantity: minutes, unitPrice: 1000, amount: total });
  }
  // The club's own time rule is used - there is no second time system
  await setSettings({ minimumBillableMinutes: 30, billingIncrementMinutes: 10 });
  const longMinimum = (await api("POST", "/bills", { body: billBody(await finishedSession(7 * 60)) })).body.data;
  assert.deepEqual([longMinimum.billedMinutes, longMinimum.total], [30, 30000]);
  const rounded = (await api("POST", "/bills", { body: billBody(await finishedSession(31 * 60)) })).body.data;
  assert.deepEqual([rounded.billedMinutes, rounded.total], [40, 40000]);
  await setSettings({ minimumBillableMinutes: 15, billingIncrementMinutes: 5 });
});

test("century bill: preview = created bill; tax and payer rules work on the per-minute amount", async () => {
  await setSettings({ gameRates: { century: 1000 }, taxEnabled: true, taxRateBasisPoints: 1600 });
  const session = await finishedSession(31 * 60); // 35 billed minutes
  const body = billBody(session, { payerRule: "split", cafeItems: [{ description: "Tea", quantity: 1, unitPrice: 5000 }] });
  const preview = (await api("POST", "/bills/preview", { body })).body.data;
  const bill = (await api("POST", "/bills", { body })).body.data;
  await setSettings({ taxEnabled: false, taxRateBasisPoints: 0 });
  assert.equal(preview.total, bill.total);
  assert.equal(bill.subtotal, 35000 + 5000);
  assert.equal(bill.taxAmount, 6400);
  assert.equal(bill.total, 46400);
  assert.deepEqual(bill.players.map((p) => p.shareAmount), [23200, 23200]);
});

test("rate snapshot: changing the rates never changes existing bills (century and frame)", async () => {
  await setSettings({ gameRates: { century: 1000, frame: 25000 } });
  const century = (await api("POST", "/bills", { body: billBody(await finishedSession(20 * 60)) })).body.data;
  const frame = (await api("POST", "/bills", { body: billBody(await finishedSession(20 * 60), { gameMode: "frame", quantity: 2 }) })).body.data;
  assert.deepEqual([century.total, frame.total, frame.unitPrice, frame.pricingType], [20000, 50000, 25000, "per_frame"]);

  await setSettings({ gameRates: { century: 1500, frame: 30000 }, minimumBillableMinutes: 60 });
  const newCentury = (await api("POST", "/bills", { body: billBody(await finishedSession(20 * 60)) })).body.data;
  assert.deepEqual([newCentury.unitPrice, newCentury.billedMinutes, newCentury.total], [1500, 60, 90000]);
  for (const [old, total, unitPrice, minutes] of [[century, 20000, 1000, 20], [frame, 50000, 25000, 20]]) {
    const again = (await api("GET", `/bills/${old.id}`)).body.data;
    assert.deepEqual([again.total, again.unitPrice, again.billedMinutes], [total, unitPrice, minutes]);
    assert.deepEqual(again.lineItems, old.lineItems);
  }
  await setSettings({ gameRates: { century: 1000, frame: 25000 }, minimumBillableMinutes: 15 });
});

test("old bills (per game, no pricingType) are read back exactly as stored", async () => {
  const session = await finishedSession(20 * 60);
  // A bill as Phases 5-11.2 saved it: Century 2 games × Rs 300, no pricingType
  const legacy = {
    billNumber: "B-20260901-0001", session: oid(session.id), tableNumber: 1, tableName: "", sessionStartedAt: new Date("2026-09-01T10:00:00Z"),
    sessionEndedAt: new Date("2026-09-01T10:20:00Z"), durationSeconds: 1200, billedMinutes: 20, gameMode: "century", quantity: 2, unitPrice: 30000,
    lineItems: [{ type: "game", description: "Century games", quantity: 2, unitPrice: 30000, amount: 60000 }],
    subtotal: 60000, taxEnabled: false, taxRateBasisPoints: 0, taxAmount: 0, total: 60000, payerRule: "loser", cafePayerRule: null,
    players: [{ name: "Ali", result: "winner", shareAmount: 0, paidAmount: 0 }, { name: "Usman", result: "loser", shareAmount: 60000, paidAmount: 0 }],
    amountPaid: 0, status: "unpaid", createdAt: new Date("2026-09-01T10:21:00Z"), updatedAt: new Date("2026-09-01T10:21:00Z"),
  };
  const { insertedId } = await db().collection("bills").insertOne(legacy);
  const bill = (await api("GET", `/bills/${insertedId}`)).body.data;
  assert.equal(bill.pricingType, undefined);
  assert.deepEqual([bill.total, bill.unitPrice, bill.quantity, bill.balanceDue], [60000, 30000, 2, 60000]);
  assert.deepEqual(bill.lineItems, legacy.lineItems);
  // It can still be paid as before
  const pay = await api("POST", `/bills/${insertedId}/payments`, { body: { amount: 60000, method: "cash", payerName: "Usman" } });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.data.bill.status, "paid");
});

test("rate 0 switches a mode off; Snooker Point and 4 Players stay disabled even with rates", async () => {
  await setSettings({ gameRates: { century: 0 } });
  const off = await api("POST", "/bills", { body: billBody(await finishedSession(20 * 60)) });
  assert.equal(off.status, 409);
  assert.equal(off.body.message, "Set the century price in Settings before creating century bills");
  await setSettings({ gameRates: { century: 1000 } });

  const session = await finishedSession(20 * 60);
  for (const gameMode of ["snooker_point", "four_player"]) {
    const result = await api("POST", "/bills/preview", { body: billBody(session, { gameMode }) });
    assert.equal(result.status, 400, gameMode);
    assert.equal(result.body.message, "Game type must be century or frame");
  }
  const modes = Object.fromEntries((await api("GET", "/game-modes", { cookie: cookies.cashier })).body.data.map((m) => [m.key, m]));
  assert.deepEqual([modes.snooker_point.rate, modes.snooker_point.enabled, modes.four_player.rate, modes.four_player.enabled], [35000, false, 50000, false]);
  assert.deepEqual([modes.century.rate, modes.century.pricingType, modes.century.rateUnit.one], [1000, "per_minute", "minute"]);
});
