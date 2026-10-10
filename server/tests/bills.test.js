// Automatic tests for settings, bills and payments (Phase 5).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user
const { dateInTimeZone } = require("../utils/time");

const TEST_DB_URI = process.env.MONGODB_BILLS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_bills";

let server;
let authCookie;
let baseUrl;
let tableCounter = 0;

async function api(method, path, body) {
  const options = { method, headers: { Cookie: authCookie } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json() };
}

const db = () => mongoose.connection;
const setSettings = (changes) => api("PATCH", "/settings", changes);

// A finished session that lasted `seconds` (start time moved into the past)
async function finishedSession(seconds = 47 * 60, name = "VIP") {
  tableCounter += 1;
  const table = (await api("POST", "/tables", { tableNumber: tableCounter, name, hourlyRate: 60000 })).body.data;
  const session = (await api("POST", "/sessions", { tableId: table.id })).body.data;
  await db().collection("sessions").updateOne(
    { _id: new mongoose.Types.ObjectId(session.id) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
  return (await api("POST", `/sessions/${session.id}/end`)).body.data;
}

const players2 = [{ name: "Ali", result: "winner" }, { name: "Usman", result: "loser" }];
const billInput = (sessionId, extra = {}) => ({ sessionId, gameMode: "century", quantity: 1, payerRule: "loser", players: players2, ...extra });
const createBill = (sessionId, extra) => api("POST", "/bills", billInput(sessionId, extra));
const pay = (billId, body) => api("POST", `/bills/${billId}/payments`, { method: "cash", ...body });

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  authCookie = await loginAs(baseUrl, "admin");
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState === 1) await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------- Settings ----------

test("settings: safe defaults, update, validation", async () => {
  const defaults = (await api("GET", "/settings")).body.data;
  assert.equal(defaults.centuryPrice, 0);
  assert.equal(defaults.framePrice, 0);
  assert.equal(defaults.minimumBillableMinutes, 15);
  assert.equal(defaults.billingIncrementMinutes, 5);
  assert.equal(defaults.taxEnabled, false);
  assert.equal(defaults.taxRateBasisPoints, 0);
  assert.equal(defaults.currency, "PKR");

  const saved = await setSettings({ centuryPrice: 30000, framePrice: 15000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.centuryPrice, 30000);

  assert.equal((await setSettings({})).status, 400);
  assert.equal((await setSettings({ taxRateBasisPoints: 10001 })).status, 400);
  assert.equal((await setSettings({ framePrice: -1 })).status, 400);
  assert.equal((await setSettings({ framePrice: 150.5 })).status, 400);
  assert.equal((await setSettings({ taxEnabled: "yes" })).status, 400);
  assert.equal((await api("GET", "/settings")).body.data.framePrice, 15000, "failed updates change nothing");
});

// ---------- Create ----------

// Phase 11.3: Century is charged per BILLED MINUTE (rate × billed minutes); before, it was
// a price per game (quantity × rate). The expected amounts below follow the new rule.
test("create: century bill, loser pays, everything calculated and copied on the server", async () => {
  await setSettings({ gameRates: { century: 1000 }, framePrice: 15000 }); // Rs 10 per minute
  const session = await finishedSession(47 * 60 + 10, "VIP");
  const { status, body } = await createBill(session.id, { quantity: 3 });

  assert.equal(status, 201);
  const bill = body.data;
  const today = dateInTimeZone(new Date(), "Asia/Karachi").replace(/-/g, "");
  assert.match(bill.billNumber, new RegExp(`^B-${today}-\\d{4}$`));
  assert.equal(body.message, `Bill ${bill.billNumber} created`);
  assert.equal(bill.session, session.id);
  assert.equal(bill.tableName, "VIP");
  assert.equal(bill.durationSeconds, session.durationSeconds);
  assert.equal(bill.billedMinutes, 50); // 47m10s -> 48 -> round up to 50
  assert.equal(bill.gameMode, "century");
  assert.equal(bill.quantity, 3, "games played is still recorded");
  assert.equal(bill.unitPrice, 1000);
  assert.equal(bill.pricingType, "per_minute");
  // 50 billed minutes × Rs 10 = Rs 500, whatever the number of games
  assert.deepEqual(bill.lineItems, [{ type: "game", description: "Century minutes", quantity: 50, unitPrice: 1000, amount: 50000 }]);
  assert.equal(bill.subtotal, 50000);
  assert.equal(bill.taxAmount, 0);
  assert.equal(bill.total, 50000);
  assert.equal(bill.status, "unpaid");
  assert.equal(bill.amountPaid, 0);
  assert.equal(bill.balanceDue, 50000);
  assert.deepEqual(bill.players.map((p) => [p.name, p.result, p.shareAmount, p.paidAmount]),
                   [["Ali", "winner", 0, 0], ["Usman", "loser", 50000, 0]]);
});

test("create: frame bill with café items, winner pays", async () => {
  const session = await finishedSession(10 * 60);
  const { status, body } = await createBill(session.id, {
    gameMode: "frame", quantity: 4, payerRule: "winner",
    cafeItems: [{ description: " Tea ", quantity: 2, unitPrice: 8000 }],
  });
  assert.equal(status, 201);
  assert.equal(body.data.billedMinutes, 15); // minimum
  assert.deepEqual(body.data.lineItems.map((l) => [l.type, l.description, l.amount]), [["game", "Frames", 60000], ["cafe", "Tea", 16000]]);
  assert.equal(body.data.total, 76000);
  assert.deepEqual(body.data.players.map((p) => p.shareAmount), [76000, 0]);
});

test("create: refused while the session runs, twice, or without a rate", async () => {
  const table = (await api("POST", "/tables", { tableNumber: 900, hourlyRate: 1 })).body.data;
  const running = (await api("POST", "/sessions", { tableId: table.id })).body.data;
  const active = await createBill(running.id);
  assert.equal(active.status, 409);
  assert.equal(active.body.message, "The session on Table 900 is still running. End it before billing.");
  await api("POST", `/sessions/${running.id}/end`);

  const first = await createBill(running.id);
  assert.equal(first.status, 201);
  const second = await createBill(running.id);
  assert.equal(second.status, 409);
  assert.equal(second.body.message, `This session already has bill ${first.body.data.billNumber}`);

  await setSettings({ framePrice: 0 });
  const noRate = await createBill((await finishedSession()).id, { gameMode: "frame" });
  assert.equal(noRate.status, 409);
  assert.equal(noRate.body.message, "Set the frame price in Settings before creating frame bills");
  await setSettings({ framePrice: 15000 });

  assert.equal((await createBill("0123456789abcdef01234567")).status, 404);
});

test("create: 5 people bill the same session at once -> exactly one bill", async () => {
  const session = await finishedSession();
  const results = await Promise.all(Array.from({ length: 5 }, () => createBill(session.id)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal(await db().collection("bills").countDocuments({ session: new mongoose.Types.ObjectId(session.id) }), 1);
});

test("create: input validation", async () => {
  const session = await finishedSession();
  const cases = [
    [{ players: [{ name: "Ali", result: "loser" }] }, "Add 2 to 4 players"],
    [{ players: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E", result: "loser" }] }, "Add 2 to 4 players"],
    [{ players: [{ name: "Ali" }, { name: "Usman" }] }, "Choose the one player who lost (the loser pays)"],
    [{ payerRule: "winner", players: [{ name: "Ali", result: "loser" }, { name: "Usman", result: "loser" }] }, "Choose the one player who won (the winner pays)"],
    [{ players: [{ name: "Ali", result: "loser" }, { name: " ali " }] }, "Each player needs a different name"],
    [{ players: [{ name: "Ali", result: "loser" }, { name: "  " }] }, "Each player needs a name (max 40 characters)"],
    [{ gameMode: "time" }, "Game type must be century or frame"],
    [{ quantity: 0 }, "Number of games/frames must be from 1 to 100"],
    [{ quantity: 1.5 }, "Number of games/frames must be from 1 to 100"],
    [{ payerRule: "house" }, "Who pays must be loser, winner or split"],
    [{ cafeItems: [{ description: "Tea", quantity: 0, unitPrice: 100 }] }, "Café item quantity must be 1 to 99"],
    [{ cafeItems: [{ description: "", quantity: 1, unitPrice: 100 }] }, "Each café item needs a name (max 60 characters)"],
    [{ cafeItems: [{ description: "Tea", quantity: 1, unitPrice: -5 }] }, "Café item price must be between Rs 0 and Rs 100,000"],
  ];
  for (const [extra, message] of cases) {
    const { status, body } = await createBill(session.id, extra);
    assert.equal(status, 400, JSON.stringify(extra));
    assert.ok(body.errors.some((e) => e.message === message), `${JSON.stringify(extra)} -> ${JSON.stringify(body.errors)}`);
  }
  // A split bill needs no winner/loser; 4 players is fine
  const split = await createBill(session.id, { payerRule: "split", players: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] });
  assert.equal(split.status, 201);
});

test("preview: same numbers as a real bill, saves nothing", async () => {
  const session = await finishedSession(31 * 60);
  const before = await db().collection("bills").countDocuments();
  const preview = await api("POST", "/bills/preview", billInput(session.id, { quantity: 2, payerRule: "split" }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.total, 35000); // 35 billed minutes × Rs 10 (11.3; was 2 games × Rs 300)
  assert.equal(preview.body.data.billedMinutes, 35);
  assert.deepEqual(preview.body.data.players.map((p) => p.shareAmount), [17500, 17500]);
  assert.equal(preview.body.data.billNumber, undefined);
  assert.equal(await db().collection("bills").countDocuments(), before);

  const real = await createBill(session.id, { quantity: 2, payerRule: "split" });
  assert.equal(real.body.data.total, preview.body.data.total);
});

test("rate snapshot: changing the rate list never changes existing bills", async () => {
  await setSettings({ gameRates: { century: 1000 } });
  const oldBill = (await createBill((await finishedSession()).id)).body.data; // 50 billed min
  await setSettings({ gameRates: { century: 1200 } });
  const newBill = (await createBill((await finishedSession()).id)).body.data;

  assert.equal(newBill.unitPrice, 1200);
  assert.equal(newBill.total, 60000);
  const reloaded = (await api("GET", `/bills/${oldBill.id}`)).body.data;
  assert.equal(reloaded.unitPrice, 1000);
  assert.equal(reloaded.total, 50000);
  await setSettings({ gameRates: { century: 1000 } });
});

test("tax: switched on later -> added to new bills only", async () => {
  await setSettings({ gameRates: { century: 1000 } });
  const before = (await createBill((await finishedSession()).id)).body.data;
  await setSettings({ taxEnabled: true, taxRateBasisPoints: 1600 });
  const taxed = (await createBill((await finishedSession()).id, { quantity: 2 })).body.data;
  await setSettings({ taxEnabled: false, taxRateBasisPoints: 0 });

  assert.equal(taxed.subtotal, 50000); // 50 billed min × Rs 10 (11.3; was 2 games × Rs 300 = 60000)
  assert.equal(taxed.taxEnabled, true);
  assert.equal(taxed.taxRateBasisPoints, 1600);
  assert.equal(taxed.taxAmount, 8000);
  assert.equal(taxed.total, 58000);
  assert.equal(before.taxAmount, 0);
  assert.equal((await api("GET", `/bills/${before.id}`)).body.data.total, 50000);
});

test("bill numbers count up within the club day", async () => {
  const a = (await createBill((await finishedSession()).id)).body.data.billNumber;
  const b = (await createBill((await finishedSession()).id)).body.data.billNumber;
  const number = (text) => Number(text.split("-")[2]);
  assert.equal(a.slice(0, 11), b.slice(0, 11));
  assert.equal(number(b), number(a) + 1);
});

// ---------- List ----------

test("list: newest first, filters, search and paging; sessions show their bill", async () => {
  const session = await finishedSession(20 * 60, "Corner Table");
  const bill = (await createBill(session.id, { players: [{ name: "Zubair", result: "loser" }, { name: "Kamran" }] })).body.data;

  const list = async (q) => (await api("GET", `/bills${q}`)).body.data;
  const all = await list("");
  assert.equal(all.bills[0].id, bill.id);
  assert.ok(all.bills.every((b, i, arr) => i === 0 || Date.parse(arr[i - 1].createdAt) >= Date.parse(b.createdAt)));

  assert.deepEqual((await list("?search=zubair")).bills.map((b) => b.id), [bill.id]);
  assert.deepEqual((await list(`?search=${bill.billNumber}`)).bills.map((b) => b.id), [bill.id]);
  assert.deepEqual((await list("?search=corner")).bills.map((b) => b.id), [bill.id]);
  assert.ok((await list("?status=unpaid")).bills.every((b) => b.status === "unpaid"));
  const open = await list("?status=open&limit=100");
  assert.ok(open.bills.length > 0 && open.bills.every((b) => b.status === "unpaid" || b.status === "partially_paid"));
  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  assert.equal((await list(`?from=${today}&to=${today}`)).total, all.total);
  assert.equal((await list("?from=2026-01-01&to=2026-01-02")).total, 0);
  const paged = await list("?limit=2&page=2");
  assert.equal(paged.bills.length, 2);
  assert.equal(paged.totalPages, Math.ceil(all.total / 2));
  assert.equal((await api("GET", "/bills?status=closed")).status, 400); // ("open" is valid since Phase 6)
  assert.equal((await api("GET", "/bills?from=2026-10-05&to=2026-10-01")).status, 400);

  const history = (await api("GET", "/sessions?status=completed&limit=100")).body.data.sessions;
  const withBill = history.find((s) => s.id === session.id);
  assert.deepEqual(withBill.bill, { id: bill.id, billNumber: bill.billNumber, status: "unpaid", total: bill.total, amountPaid: 0 });
  const unbilled = await finishedSession();
  const unbilledRow = (await api("GET", "/sessions?status=completed&limit=100")).body.data.sessions.find((s) => s.id === unbilled.id);
  assert.equal(unbilledRow.bill, null);
});

// ---------- Payments ----------
// These tests are about payments, not prices. Since Phase 11.3 Century is per minute, so they set
// Rs 6/minute: the default 47 min session = 50 billed min × Rs 6 = Rs 300, the amount they were written for.
const century300 = () => setSettings({ gameRates: { century: 600 } });

test("payments: split bill, partial payments per player, then paid", async () => {
  await century300();
  const bill = (await createBill((await finishedSession()).id, { payerRule: "split" })).body.data; // 30000 -> 15000 each

  const p1 = await pay(bill.id, { amount: 10000, payerName: "ali" }); // name matched without case
  assert.equal(p1.status, 201);
  assert.equal(p1.body.message, "Payment saved");
  assert.equal(p1.body.data.payment.payerName, "Ali");
  assert.equal(p1.body.data.bill.status, "partially_paid");
  assert.equal(p1.body.data.bill.balanceDue, 20000);

  const tooMuchForAli = await pay(bill.id, { amount: 6000, payerName: "Ali" });
  assert.equal(tooMuchForAli.status, 409);
  assert.equal(tooMuchForAli.body.message, "Ali only owes Rs 50.00 more");

  assert.equal((await pay(bill.id, { amount: 15000, payerName: "Usman", method: "jazzcash" })).body.data.bill.status, "partially_paid");
  const last = await pay(bill.id, { amount: 5000, payerName: "Ali", method: "card", note: "rest" });
  assert.equal(last.body.data.bill.status, "paid");
  assert.equal(last.body.message, `Payment saved. Bill ${bill.billNumber} is fully paid`);

  const done = await pay(bill.id, { amount: 1, payerName: "Ali" });
  assert.equal(done.status, 409);
  assert.equal(done.body.message, `Bill ${bill.billNumber} is already fully paid`);

  const full = (await api("GET", `/bills/${bill.id}`)).body.data;
  assert.equal(full.amountPaid, 30000);
  assert.equal(full.balanceDue, 0);
  assert.deepEqual(full.players.map((p) => p.paidAmount), [15000, 15000]);
  assert.deepEqual(full.payments.map((p) => [p.payerName, p.amount, p.method]), [["Ali", 10000, "cash"], ["Usman", 15000, "jazzcash"], ["Ali", 5000, "card"]]);
});

test("payments: overpayment and wrong payers are refused", async () => {
  await century300();
  const bill = (await createBill((await finishedSession()).id)).body.data; // loser (Usman) pays 30000

  const over = await pay(bill.id, { amount: 30001, payerName: "Usman" });
  assert.equal(over.status, 409);
  assert.equal(over.body.message, "Payment of Rs 300.01 is more than the remaining balance of Rs 300.00");

  const winner = await pay(bill.id, { amount: 100, payerName: "Ali" });
  assert.equal(winner.status, 409);
  assert.equal(winner.body.message, "Ali doesn't owe anything on this bill");

  const stranger = await pay(bill.id, { amount: 100, payerName: "Bilal" });
  assert.equal(stranger.status, 400);

  for (const body of [{ amount: 0, payerName: "Usman" }, { amount: 10.5, payerName: "Usman" },
                      { amount: 100, payerName: "Usman", method: "cheque" }, { amount: 100 }]) {
    assert.equal((await pay(bill.id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await pay("0123456789abcdef01234567", { amount: 100, payerName: "Usman" })).status, 404);
  assert.equal((await api("GET", `/bills/${bill.id}`)).body.data.amountPaid, 0);
});

test("payments: 10 payments at the same moment can never exceed the total", async () => {
  await century300();
  const bill = (await createBill((await finishedSession()).id)).body.data; // 30000
  const results = await Promise.all(Array.from({ length: 10 }, () => pay(bill.id, { amount: 5000, payerName: "Usman" })));

  assert.equal(results.filter((r) => r.status === 201).length, 6);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  const final = (await api("GET", `/bills/${bill.id}`)).body.data;
  assert.equal(final.amountPaid, 30000);
  assert.equal(final.status, "paid");
  assert.equal(final.payments.length, 6);
});

// ---------- Cancel ----------

test("cancel: only unpaid bills; cancelled bills take no payments", async () => {
  const unpaid = (await createBill((await finishedSession()).id)).body.data;
  const cancelled = await api("POST", `/bills/${unpaid.id}/cancel`, { reason: "Wrong table" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.equal(cancelled.body.data.cancelReason, "Wrong table");
  assert.equal(cancelled.body.data.balanceDue, 0);
  assert.equal((await api("POST", `/bills/${unpaid.id}/cancel`)).status, 409);
  const payCancelled = await pay(unpaid.id, { amount: 100, payerName: "Usman" });
  assert.equal(payCancelled.status, 409);
  assert.equal(payCancelled.body.message, `Bill ${unpaid.billNumber} is cancelled`);

  const partly = (await createBill((await finishedSession()).id)).body.data;
  await pay(partly.id, { amount: 100, payerName: "Usman" });
  const refused = await api("POST", `/bills/${partly.id}/cancel`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /already has payments of Rs 1\.00/);

  assert.equal((await api("POST", "/bills/0123456789abcdef01234567/cancel")).status, 404);
  assert.ok((await api("GET", "/bills?status=cancelled")).body.data.bills.some((b) => b.id === unpaid.id));
});
