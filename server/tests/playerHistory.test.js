// Tests for Phase 11.6: café & player billing.
//
//   Player -> Match -> Bill -> Payment
//   Player -> Café consumer -> Bill
//
// A registered player's matches, bills and outstanding money are WORKED OUT from the match, bill and
// payment records (no counters). Walk-ins, old bills and the Phase 11.5 billing rules keep working.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const { splitShares } = require("../services/billing.calculator");
const { roleHasPermission } = require("../config/permissions");

const TEST_DB_URI = process.env.MONGODB_PLAYERHISTORY_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_playerhistory";

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
async function ok(method, path, options) {
  const result = await api(method, path, options);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
}

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);
const RATES = { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 };

async function openSession() {
  tableNumber += 1;
  const table = await ok("POST", "/tables", { body: { tableNumber, name: `T${tableNumber}`, hourlyRate: 1 } });
  return ok("POST", "/sessions", { body: { tableId: table.id } });
}
async function endSession(session, seconds) {
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
  return ok("POST", `/sessions/${session.id}/end`);
}
const walkIn = (name, extra = {}) => ({ playerId: null, name, ...extra });
const reg = (p, extra = {}) => ({ playerId: p.id, ...extra });
async function playMatch(session, gameMode, players, result) {
  const match = await ok("POST", `/sessions/${session.id}/matches`, { body: { gameMode, players } });
  return result ? ok("POST", `/matches/${match.id}/complete`, { body: result }) : match;
}
async function billMatch(match, body = { payerRule: "loser" }) {
  const result = await api("POST", `/matches/${match.id}/bill`, { body });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}
const pay = (bill, payerName, amount) => ok("POST", `/bills/${bill.id}/payments`, { body: { amount, method: "cash", payerName } });
const newPlayer = (name) => ok("POST", "/players", { body: { name } });
const playerBills = (player, query = "", cookie) => ok("GET", `/players/${player.id}/bills${query}`, { cookie });
const playerMatches = (player, query = "", cookie) => ok("GET", `/players/${player.id}/matches${query}`, { cookie });
const sum = (bill) => bill.players.reduce((total, p) => total + p.shareAmount, 0);

// A bill stored straight into the database, the way older versions saved them (no match, no player references)
function rawBill(extra) {
  const at = new Date("2026-09-15T12:00:00Z");
  return {
    billNumber: `B-OLD-${Math.random().toString(36).slice(2, 10)}`, session: new mongoose.Types.ObjectId(), tableNumber: 99, tableName: "Old",
    sessionStartedAt: at, sessionEndedAt: at, durationSeconds: 3600, billedMinutes: 60, gameMode: "frame", quantity: 1, unitPrice: 30000,
    lineItems: [{ type: "game", description: "Frame", quantity: 1, unitPrice: 30000, amount: 30000 }],
    subtotal: 30000, taxEnabled: false, taxRateBasisPoints: 0, taxAmount: 0, total: 30000,
    amountPaid: 0, status: "unpaid", cancelledAt: null, cancelReason: "", createdAt: at, updatedAt: at,
    ...extra,
  };
}

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
  await ok("PATCH", "/settings", { body: { gameRates: RATES } });
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
// 1-2. Registered and walk-in players on a match bill
// ---------------------------------------------------------------------------

test("registered player on a match bill: reference + name copy; a later rename or deactivation changes nothing", async () => {
  const ali = await newPlayer("Ali");
  const session = await openSession();
  const match = await playMatch(session, "frame", [reg(ali), walkIn("Guest")], { winnerSeat: 2 });
  await endSession(session, 20 * 60);
  const bill = await billMatch(match);
  assert.deepEqual(bill.players.map((p) => [p.name, p.player || null, p.result, p.shareAmount]), [["Ali", ali.id, "loser", 25000], ["Guest", null, "winner", 0]]);

  await ok("PATCH", `/players/${ali.id}`, { body: { name: "Ali Raza" } });
  await ok("POST", `/players/${ali.id}/deactivate`);
  const stored = await ok("GET", `/bills/${bill.id}`);
  assert.equal(stored.players[0].name, "Ali", "the bill keeps the name it was made with");
  assert.equal((await ok("GET", `/matches/${match.id}`)).players[0].name, "Ali", "so does the match");

  // The history is found through the reference, not the name - and stays readable for an inactive player
  const history = await playerBills(ali);
  assert.deepEqual([history.player.name, history.player.isActive, history.total], ["Ali Raza", false, 1]);
  assert.deepEqual([history.bills[0].billNumber, history.bills[0].share.name, history.bills[0].share.shareAmount], [bill.billNumber, "Ali", 25000]);
  const matches = await playerMatches(ali);
  assert.deepEqual([matches.total, matches.matches[0].nameInMatch, matches.matches[0].result], [1, "Ali", "loser"]);
});

test("walk-in players still work: no Player record is created, the bill has names only", async () => {
  const before = await db().collection("players").countDocuments();
  const session = await openSession();
  const match = await playMatch(session, "snooker_point", [walkIn("Walk One"), walkIn("Walk Two"), walkIn("Walk Three")], { winnerSeat: 1 });
  await endSession(session, 20 * 60);
  const bill = await billMatch(match);
  assert.deepEqual(shareRows(bill), [["Walk One", "winner", 0], ["Walk Two", "loser", 17500], ["Walk Three", "loser", 17500]]);
  assert.ok(bill.players.every((p) => p.player === undefined), "walk-ins have no player reference");
  assert.equal(await db().collection("players").countDocuments(), before, "nothing registered for walk-ins");
  // and they can pay as before
  const paid = await pay(bill, "walk two", 17500);
  assert.equal(paid.bill.status, "partially_paid");
});
const shareRows = (bill) => bill.players.map((p) => [p.name, p.result, p.shareAmount]);

// ---------------------------------------------------------------------------
// 3-4. Café: consumer pays
// ---------------------------------------------------------------------------

test("consumer pays with registered consumers: Tea Rs 150 -> Ali, Burger Rs 300 -> Ahmed; the player reference is stored", async () => {
  const ali = await newPlayer("Ali Consumer");
  const ahmed = await newPlayer("Ahmed Consumer");
  const session = await openSession();
  const match = await playMatch(session, "frame", [reg(ali), reg(ahmed)], { winnerSeat: 1 }); // Ahmed lost
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { description: "Tea", unitPrice: 15000, quantity: 1, consumer: "ali consumer" } });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { description: "Burger", unitPrice: 30000, quantity: 1, consumer: "Ahmed Consumer" } });
  await endSession(session, 20 * 60);

  const bill = await billMatch(match, { payerRule: "loser", cafePayerRule: "consumer" });
  const cafe = bill.lineItems.filter((l) => l.type === "cafe");
  assert.deepEqual(cafe.map((l) => [l.description, l.amount, l.consumer, l.consumerPlayer]),
    [["Tea", 15000, "Ali Consumer", ali.id], ["Burger", 30000, "Ahmed Consumer", ahmed.id]], "name copy + player reference");
  assert.deepEqual(bill.players.map((p) => [p.name, p.cafeShare]), [["Ali Consumer", 15000], ["Ahmed Consumer", 30000]], "Ali = Rs 150, Ahmed = Rs 300");
  assert.deepEqual(bill.players.map((p) => [p.gameShare, p.shareAmount]), [[0, 15000], [25000, 55000]], "the game still follows Loser Pays");
  assert.equal(sum(bill), bill.total);

  // The player history shows what each one had
  const aliBill = (await playerBills(ali)).bills[0];
  assert.deepEqual(aliBill.cafeItems, [{ description: "Tea", quantity: 1, amount: 15000 }]);
  assert.deepEqual([aliBill.share.cafeShare, aliBill.share.outstanding], [15000, 15000]);
  assert.deepEqual((await playerBills(ahmed)).bills[0].cafeItems.map((c) => c.description), ["Burger"]);
});

test("consumer pays with a walk-in consumer: allowed, stored by name only; registered names up to 60 characters fit the tab", async () => {
  const ali = await newPlayer("Ali Walkin Test");
  const longName = "Muhammad Abdullah Rehman Siddiqui Khan Yousafzai Durrani Qrs"; // 60 characters
  assert.equal(longName.length, 60);
  const long = await newPlayer(longName);
  const session = await openSession();
  const match = await playMatch(session, "century", [reg(ali), walkIn("Guest"), reg(long)], { winnerSeat: 1 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { description: "Chips", unitPrice: 5000, quantity: 2, consumer: "guest" } });
  const longItem = await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { description: "Water", unitPrice: 2000, quantity: 1, consumer: longName } });
  assert.equal(longItem.consumer, longName, "a 60-character registered name fits 'who had it'");
  await endSession(session, 15 * 60); // 15 billed minutes = Rs 150

  // Not every consumer has to be registered: the walk-in "Guest" had the chips
  const preview = await ok("POST", `/matches/${match.id}/bill/preview`, { body: { payerRule: "loser", cafePayerRule: "consumer" } });
  const cafe = preview.lineItems.filter((l) => l.type === "cafe");
  assert.deepEqual(cafe.map((l) => [l.description, l.consumer, l.consumerPlayer || null]), [["Chips", "Guest", null], ["Water", longName, long.id]]);
  assert.deepEqual(preview.players.map((p) => p.cafeShare), [0, 10000, 2000]);
  // Someone who isn't a player on this bill can't be the consumer (the café must be paid by someone on it)
  const items = (await ok("GET", `/sessions/${session.id}/cafe-items`)).items;
  const stranger = await api("POST", `/matches/${match.id}/bill/preview`, {
    body: { payerRule: "loser", cafePayerRule: "consumer", tabItems: [{ id: items[0].id, consumer: "Somebody Else" }, { id: items[1].id, consumer: longName }] },
  });
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.message, /Somebody Else is not a player on this bill/);
  const bill = await billMatch(match, { payerRule: "loser", cafePayerRule: "consumer" });
  assert.equal(sum(bill), bill.total);
});

// ---------------------------------------------------------------------------
// 5-10. Billing history and outstanding
// ---------------------------------------------------------------------------

test("billing history and outstanding: unpaid, partly paid, paid, cancelled and zero-share bills; several bills; paging", async () => {
  const hamza = await newPlayer("Hamza");
  // Bill A: Century, 50 billed minutes = Rs 500, Hamza lost and pays it all -> pays Rs 300 -> owes Rs 200
  const s1 = await openSession();
  const century = await playMatch(s1, "century", [reg(hamza), walkIn("Opp A")], { winnerSeat: 2 });
  await endSession(s1, 47 * 60);
  const a = await billMatch(century);
  assert.equal(a.total, 50000);
  await pay(a, "Hamza", 30000);

  // Session 2: four frames
  const s2 = await openSession();
  const fb = await playMatch(s2, "frame", [reg(hamza), walkIn("Opp B")], { winnerSeat: 2 }); // B: paid in full
  const fc = await playMatch(s2, "frame", [reg(hamza), walkIn("Opp C")], { winnerSeat: 2 }); // C: cancelled
  const fd = await playMatch(s2, "frame", [reg(hamza), walkIn("Opp D")], { winnerSeat: 1 }); // D: Hamza won, owes nothing
  const fe = await playMatch(s2, "frame", [reg(hamza), walkIn("Opp E")], { winnerSeat: 2 }); // E: unpaid
  await endSession(s2, 30 * 60);
  const b = await billMatch(fb);
  await pay(b, "Hamza", 25000);
  const c = await billMatch(fc);
  await ok("POST", `/bills/${c.id}/cancel`, { body: { reason: "Wrong table" } });
  const d = await billMatch(fd);
  const e = await billMatch(fe);

  const history = await playerBills(hamza, "?limit=10");
  assert.equal(history.total, 5, "every bill the player is on, cancelled ones included");
  assert.deepEqual(history.bills.map((x) => x.billNumber), [e, d, c, b, a].map((x) => x.billNumber), "newest first");
  const row = (bill) => history.bills.find((x) => x.id === bill.id);
  // Bill number, date, game type, amount, paid, outstanding, status
  assert.deepEqual(Object.keys(row(a)).filter((k) => ["billNumber", "createdAt", "gameMode", "total", "amountPaid", "balanceDue", "status"].includes(k)).length, 7);
  assert.deepEqual([row(a).gameMode, row(a).matchNumber, row(a).total, row(a).amountPaid, row(a).balanceDue, row(a).status], ["century", 1, 50000, 30000, 20000, "partially_paid"]);
  assert.deepEqual([row(a).share.shareAmount, row(a).share.paidAmount, row(a).share.outstanding], [50000, 30000, 20000], "Rs 500 - Rs 300 = Rs 200");
  assert.deepEqual([row(b).status, row(b).share.outstanding, row(b).balanceDue], ["paid", 0, 0], "a paid bill owes nothing");
  assert.deepEqual([row(c).status, row(c).share.shareAmount, row(c).share.outstanding, row(c).balanceDue], ["cancelled", 25000, 0, 0], "a cancelled bill owes nothing");
  assert.deepEqual([row(d).share.result, row(d).share.shareAmount, row(d).share.outstanding], ["winner", 0, 0]);
  assert.deepEqual([row(e).status, row(e).share.outstanding], ["unpaid", 25000]);

  assert.deepEqual(history.summary, {
    bills: 4,            // A, B, D, E (C is cancelled)
    cancelledBills: 1,
    openBills: 2,        // A and E: where Hamza still owes
    totalShare: 100000,  // 500 + 250 + 0 + 250 (the cancelled bill isn't counted)
    totalPaid: 55000,    // 300 + 250
    outstanding: 45000,  // 200 + 250
  });

  // Paging and the "open" filter; the summary always covers ALL bills
  const page1 = await playerBills(hamza, "?limit=2");
  const page3 = await playerBills(hamza, "?limit=2&page=3");
  assert.deepEqual([page1.bills.length, page1.totalPages, page3.bills.map((x) => x.id)], [2, 3, [a.id]]);
  assert.equal(page3.summary.outstanding, 45000);
  // "open" = the BILL is still being collected (like the Billing page): D is open because the opponent owes
  const open = await playerBills(hamza, "?status=open");
  assert.deepEqual(open.bills.map((x) => x.id), [e.id, d.id, a.id]);
  assert.deepEqual(open.bills.map((x) => x.share.outstanding), [25000, 0, 20000]);

  // Outstanding follows payments: Hamza pays the rest -> 0
  await pay(a, "Hamza", 20000);
  await pay(e, "Hamza", 25000);
  const after = await playerBills(hamza);
  assert.deepEqual([after.summary.outstanding, after.summary.openBills, after.summary.totalPaid], [0, 0, 100000]);
  assert.equal((await ok("GET", `/players/${hamza.id}`)).outstanding, undefined, "no outstanding counter is stored on the player");
});

test("outstanding is the player's OWN share: a team-mate's or opponent's debt is not theirs", async () => {
  const p1 = await newPlayer("Team Mate One");
  const p2 = await newPlayer("Team Mate Two");
  const session = await openSession();
  const match = await playMatch(session, "four_player",
    [reg(p1, { team: 1 }), reg(p2, { team: 1 }), walkIn("Win One", { team: 2 }), walkIn("Win Two", { team: 2 })], { winningTeam: 2 });
  await endSession(session, 20 * 60);
  const bill = await billMatch(match); // the losing team pays Rs 500: Rs 250 each
  await pay(bill, "Team Mate One", 25000);
  const one = await playerBills(p1);
  const two = await playerBills(p2);
  assert.deepEqual([one.summary.outstanding, two.summary.outstanding], [0, 25000]);
  assert.deepEqual([one.bills[0].balanceDue, one.bills[0].status], [25000, "partially_paid"], "the bill itself still has Rs 250 to collect");
});

// ---------------------------------------------------------------------------
// 11. Match history
// ---------------------------------------------------------------------------

test("match history: from the Match records - opponents, result, teams, bill status; statistics derived, never stored", async () => {
  const saad = await newPlayer("Saad");
  const other = await newPlayer("Other Player");
  const session = await openSession();
  const m1 = await playMatch(session, "frame", [reg(saad), walkIn("Guest")], { winnerSeat: 1 });           // won
  const m2 = await playMatch(session, "frame", [walkIn("P"), reg(saad), reg(other)], { winnerSeat: 1 });     // lost
  const m3 = await playMatch(session, "four_player",
    [reg(saad, { team: 1 }), walkIn("Mate", { team: 1 }), walkIn("Z1", { team: 2 }), walkIn("Z2", { team: 2 })], { winningTeam: 2 }); // team lost
  const m4 = await playMatch(session, "frame", [reg(saad), walkIn("Q")]);
  await ok("POST", `/matches/${m4.id}/cancel`, { body: { reason: "Left early" } });
  const m5 = await playMatch(session, "frame", [reg(saad), walkIn("R")]); // still in progress
  // A walk-in who happens to be called "Saad" is NOT this player (no matching by name)
  await playMatch(session, "frame", [walkIn("saad"), walkIn("S")], { winnerSeat: 1 });
  await endSession(session, 30 * 60);
  const bill = await billMatch(m1, { payerRule: "split" });

  const history = await playerMatches(saad);
  assert.deepEqual(history.stats, { total: 5, completed: 3, inProgress: 1, cancelled: 1, wins: 1, losses: 2 });
  assert.deepEqual(history.matches.map((m) => m.number), [m5, m4, m3, m2, m1].map((m) => m.number), "newest first");
  const row = (m) => history.matches.find((x) => x.id === m.id);
  assert.deepEqual([row(m1).result, row(m1).opponents, row(m1).bill], ["winner", [{ name: "Guest", registered: false, result: "loser", team: null }],
    { id: bill.id, billNumber: bill.billNumber, status: "unpaid" }]);
  assert.deepEqual([row(m2).result, row(m2).opponents.map((p) => `${p.name}:${p.registered}`), row(m2).bill], ["loser", ["P:false", "Other Player:true"], null]);
  assert.deepEqual([row(m3).gameMode, row(m3).team, row(m3).result, row(m3).winningTeam, row(m3).losingTeam], ["four_player", 1, "loser", 2, 1]);
  assert.deepEqual([row(m3).teammates.map((p) => p.name), row(m3).opponents.map((p) => p.name)], [["Mate"], ["Z1", "Z2"]]);
  assert.deepEqual([row(m4).status, row(m4).result], ["cancelled", null]);
  assert.deepEqual([row(m5).status, row(m5).result], ["in_progress", null]);
  assert.ok(history.matches.every((m) => m.gameMode && m.startedAt && m.tableNumber));

  // The other registered player sees only their own match; paging works
  assert.deepEqual((await playerMatches(other)).matches.map((m) => m.id), [m2.id]);
  const page = await playerMatches(saad, "?limit=2&page=2");
  assert.deepEqual([page.matches.map((m) => m.id), page.totalPages, page.stats.total], [[m3.id, m2.id], 3, 5]);
  // Nothing is written on the player
  const stored = await db().collection("players").findOne({ _id: oid(saad.id) });
  assert.deepEqual(Object.keys(stored).filter((k) => /win|loss|match|game|outstanding/i.test(k)), []);
});

// ---------------------------------------------------------------------------
// 12-13. Both Pay
// ---------------------------------------------------------------------------

test("Both Pay: odd paisa go to the first payers and the parts always add up to the bill", async () => {
  const session = await openSession();
  const point = await playMatch(session, "snooker_point", [walkIn("A1"), walkIn("A2"), walkIn("A3")], { winnerSeat: 1 });
  const frame = await playMatch(session, "frame", [walkIn("B1"), walkIn("B2"), walkIn("B3")], { winnerSeat: 2 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { description: "Juice", unitPrice: 1000, quantity: 1, consumer: "" } });
  await endSession(session, 20 * 60);

  const p = await billMatch(point, { payerRule: "split", includeCafeTab: false });
  assert.deepEqual(p.players.map((x) => x.shareAmount), [11667, 11667, 11666], "Rs 350 / 3");
  assert.equal(sum(p), 35000);
  const f = await billMatch(frame, { payerRule: "split", cafePayerRule: "split" }); // Rs 250 + café Rs 10 = Rs 260
  assert.deepEqual(f.players.map((x) => x.shareAmount), [8667, 8667, 8666]);
  assert.equal(sum(f), f.total);
  // The calculator itself, with many payers
  for (const total of [1, 2, 100, 99999, 1000001]) {
    const parts = splitShares(total, Array.from({ length: 7 }, () => ({})), "split");
    assert.equal(parts.reduce((s, x) => s + x, 0), total);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
  }
});

test("legacy 'split_equally' is read as Both Pay: the bill opens, shows in the player's history and can be paid", async () => {
  const lee = await newPlayer("Legacy Lee");
  // A value the code never wrote - if old data has it, everyone pays (exactly like "split")
  const players = [{ name: "Legacy Lee" }, { name: "B" }, { name: "C" }];
  assert.deepEqual(splitShares(10001, players, "split_equally"), splitShares(10001, players, "split"));
  const { insertedId } = await db().collection("bills").insertOne(rawBill({
    total: 30001, subtotal: 30001, payerRule: "split_equally", cafePayerRule: "split_equally",
    lineItems: [{ type: "game", description: "Frame", quantity: 1, unitPrice: 30001, amount: 30001 }],
    players: [{ name: "Legacy Lee", player: oid(lee.id), result: null, shareAmount: 15001, paidAmount: 0 }, { name: "Other", result: null, shareAmount: 15000, paidAmount: 0 }],
  }));
  const bill = await ok("GET", `/bills/${insertedId}`);
  assert.deepEqual([bill.payerRule, bill.balanceDue], ["split_equally", 30001]);
  const history = await playerBills(lee);
  assert.deepEqual([history.bills[0].payerRule, history.summary.outstanding], ["split_equally", 15001]);
  const paid = await pay({ id: String(insertedId) }, "Legacy Lee", 15001);
  assert.equal(paid.bill.status, "partially_paid");
  assert.equal((await playerBills(lee)).summary.outstanding, 0);
});

// ---------------------------------------------------------------------------
// 14. Old bills
// ---------------------------------------------------------------------------

test("old bills without player references stay readable and are never linked to a player by name", async () => {
  const { insertedId } = await db().collection("bills").insertOne(rawBill({
    payerRule: "loser",
    players: [{ name: "Old Timer", result: "loser", shareAmount: 30000, paidAmount: 0 }, { name: "Zed", result: "winner", shareAmount: 0, paidAmount: 0 }],
  }));
  // Registered later with the same name: still not linked (no guessing from names)
  const oldTimer = await newPlayer("Old Timer");
  const bill = await ok("GET", `/bills/${insertedId}`);
  assert.deepEqual([bill.match, bill.pricingType, bill.players[0].player, bill.balanceDue], [undefined, undefined, undefined, 30000]);
  assert.ok((await ok("GET", "/bills?search=Old%20Timer")).bills.some((b) => b.id === String(insertedId)));
  assert.deepEqual([(await playerBills(oldTimer)).total, (await playerMatches(oldTimer)).total], [0, 0]);
  const paid = await pay({ id: String(insertedId) }, "Old Timer", 30000);
  assert.equal(paid.bill.status, "paid", "payments on old bills work as before");
  const stored = await db().collection("bills").findOne({ _id: insertedId });
  assert.equal(stored.players[0].player, undefined, "the old bill was not rewritten with a reference");
});

// ---------------------------------------------------------------------------
// 15. Café stock safety (Phase 10 / 11.5 rules unchanged)
// ---------------------------------------------------------------------------

test("café stock safety with a registered consumer: short stock takes nothing; one item never on two bills; cancel puts it back", async () => {
  const ali = await newPlayer("Stock Ali");
  const cat = await ok("POST", "/categories", { body: { name: "Cold drinks" } });
  const cola = await ok("POST", "/products", { body: { name: "Cola", categoryId: cat.id, price: 8000, stockQuantity: 2 } });
  const session = await openSession();
  const first = await playMatch(session, "frame", [reg(ali), walkIn("Guest")], { winnerSeat: 2 });
  const second = await playMatch(session, "frame", [reg(ali), walkIn("Guest")], { winnerSeat: 1 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 2, consumer: "Stock Ali" } });
  await endSession(session, 20 * 60);
  const stock = async () => (await ok("GET", `/products/${cola.id}`)).stockQuantity;

  await db().collection("products").updateOne({ _id: oid(cola.id) }, { $set: { stockQuantity: 1 } });
  const short = await api("POST", `/matches/${first.id}/bill`, { body: { payerRule: "loser", cafePayerRule: "consumer" } });
  assert.equal(short.status, 409);
  assert.equal(await stock(), 1, "nothing taken");
  assert.equal(await db().collection("bills").countDocuments({ session: oid(session.id) }), 0);
  assert.ok((await ok("GET", `/sessions/${session.id}/cafe-items`)).items.every((i) => i.status === "open"), "the tab is still open");

  await db().collection("products").updateOne({ _id: oid(cola.id) }, { $set: { stockQuantity: 2 } });
  const bill = await billMatch(first, { payerRule: "loser", cafePayerRule: "consumer" });
  assert.deepEqual([bill.lineItems[1].consumerPlayer, bill.players[0].cafeShare, await stock()], [ali.id, 16000, 0]);
  const next = await billMatch(second);
  assert.equal(next.lineItems.length, 1, "the café items are on the first bill only");
  await ok("POST", `/bills/${bill.id}/cancel`, { body: {} });
  assert.equal(await stock(), 2, "cancel puts the stock back");
  const history = await playerBills(ali);
  assert.deepEqual(history.bills.map((b) => [b.status, b.share.outstanding]), [["unpaid", 0], ["cancelled", 0]]);
});

// ---------------------------------------------------------------------------
// 16. Permissions
// ---------------------------------------------------------------------------

test("permissions: every role can see a player's history (as players + matches + bills already); nothing else changed", async () => {
  const p = await newPlayer("Perm Player");
  for (const role of ["admin", "staff", "cashier"]) {
    assert.equal((await api("GET", `/players/${p.id}/matches`, { cookie: cookies[role] })).status, 200, role);
    assert.equal((await api("GET", `/players/${p.id}/bills`, { cookie: cookies[role] })).status, 200, role);
  }
  assert.equal((await api("GET", `/players/${p.id}/bills`, { cookie: null })).status, 401);
  assert.equal((await api("GET", `/players/${p.id}/matches`, { cookie: null })).status, 401);
  // The existing player rules are unchanged
  assert.equal((await api("POST", "/players", { body: { name: "Sneaky" }, cookie: cookies.cashier })).status, 403);
  assert.equal((await api("POST", `/players/${p.id}/deactivate`, { cookie: cookies.staff })).status, 403);
  assert.deepEqual(["players:view", "players:manage", "players:deactivate", "bills:view", "payments:record", "bills:cancel"].map((perm) =>
    ["admin", "staff", "cashier"].filter((role) => roleHasPermission(role, perm)).join("+")),
  ["admin+staff+cashier", "admin+staff", "admin", "admin+staff+cashier", "admin+cashier", "admin+cashier"]);
  // History is read-only and checked like every other endpoint
  assert.equal((await api("GET", `/players/${new mongoose.Types.ObjectId()}/bills`)).status, 404);
  assert.equal((await api("GET", "/players/not-an-id/matches")).status, 400);
  assert.equal((await api("GET", `/players/${p.id}/bills?status=everything`)).status, 400);
  assert.equal((await api("POST", `/players/${p.id}/bills`, { body: {} })).status, 404);
});
