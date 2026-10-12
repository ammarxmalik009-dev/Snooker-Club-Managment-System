// Tests for Phase 11.5: Session -> Match -> Bill -> Payment.
// One bill per COMPLETED match; a session with several matches has several bills.
// Bills made for a whole session (the Create Bill window, and every older bill) keep working.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const { dateInTimeZone, startOfDayInTimeZone } = require("../utils/time");

const TEST_DB_URI = process.env.MONGODB_MATCHBILLS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_matchbills";

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
// Ends the session as if it had lasted `seconds` (the session is the clock)
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
const billMatch = (match, body = { payerRule: "loser" }, cookie) => api("POST", `/matches/${match.id}/bill`, { body, cookie });
const previewMatch = (match, body) => ok("POST", `/matches/${match.id}/bill/preview`, { body });
const shares = (bill) => bill.players.map((p) => [p.name, p.result, p.shareAmount]);
const sum = (bill) => bill.players.reduce((total, p) => total + p.shareAmount, 0);
const four = (names) => names.map((name, i) => walkIn(name, { team: i < 2 ? 1 : 2 }));

let ali;
let ahmed;
let bilal;

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
  ali = await ok("POST", "/players", { body: { name: "Ali" } });
  ahmed = await ok("POST", "/players", { body: { name: "Ahmed" } });
  bilal = await ok("POST", "/players", { body: { name: "Bilal" } });
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
// The match bill
// ---------------------------------------------------------------------------

test("century match bill: game type, players and result from the match; session minutes × today's rate", async () => {
  const session = await openSession();
  const match = await playMatch(session, "century", [reg(ali), reg(ahmed), walkIn("Guest")], { winnerSeat: 1 });
  await endSession(session, 47 * 60 + 10); // 50 billed minutes
  const { status, body } = await billMatch(match);
  assert.equal(status, 201);
  const bill = body.data;
  assert.equal(body.message, `Bill ${bill.billNumber} created for match #1`);
  assert.deepEqual([bill.match, bill.matchNumber, bill.session, bill.gameMode, bill.pricingType, bill.unitPrice, bill.billedMinutes, bill.quantity],
    [match.id, 1, session.id, "century", "per_minute", 1000, 50, 1]);
  assert.deepEqual(bill.lineItems, [{ type: "game", description: "Century minutes", quantity: 50, unitPrice: 1000, amount: 50000 }]);
  // Loser pays: Ahmed and Guest lost (3 players) -> equal parts; the registered players keep their reference
  assert.deepEqual(shares(bill), [["Ali", "winner", 0], ["Ahmed", "loser", 25000], ["Guest", "loser", 25000]]);
  assert.deepEqual(bill.players.map((p) => p.player || null), [ali.id, ahmed.id, null], "walk-in has no player reference");
  // Both sides point to each other
  assert.equal((await ok("GET", `/matches/${match.id}`)).bill, bill.id);
  const fetched = await ok("GET", `/matches/${match.id}/bill`, { cookie: cookies.staff });
  assert.deepEqual([fetched.id, fetched.payments], [bill.id, []]);
});

test("frame: one match = one frame (quantity 1, Rs 250); another frame is another match with its own bill", async () => {
  const session = await openSession();
  const first = await playMatch(session, "frame", [reg(ali), reg(bilal)], { winnerSeat: 2 });
  const second = await playMatch(session, "frame", [reg(ali), reg(bilal)], { winnerSeat: 1 });
  await endSession(session, 40 * 60);
  const a = (await billMatch(first)).body.data;
  const b = (await billMatch(second)).body.data;
  for (const bill of [a, b]) {
    assert.deepEqual([bill.quantity, bill.unitPrice, bill.pricingType, bill.total], [1, 25000, "per_frame", 25000]);
    assert.deepEqual(bill.lineItems[0], { type: "game", description: "Frame", quantity: 1, unitPrice: 25000, amount: 25000 });
  }
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.matchNumber, b.matchNumber], [1, 2]);
  assert.deepEqual([shares(a)[0][2], shares(b)[1][2]], [25000, 25000], "each frame's own loser pays");
});

test("snooker point (Rs 350) and 4 Players (Rs 500) bill at today's rate; teams kept on the bill", async () => {
  const session = await openSession();
  const point = await playMatch(session, "snooker_point", [reg(ali), walkIn("Guest"), reg(bilal)], { winnerSeat: 2 });
  const team = await playMatch(session, "four_player", [reg(ali, { team: 1 }), reg(ahmed, { team: 1 }), reg(bilal, { team: 2 }), walkIn("Usman", { team: 2 })], { winningTeam: 1 });
  await endSession(session, 30 * 60);
  const p = (await billMatch(point)).body.data;
  assert.deepEqual([p.gameMode, p.total, p.lineItems[0].description, p.lineItems[0].quantity, p.winningTeam], ["snooker_point", 35000, "Snooker Point game", 1, undefined]);
  assert.deepEqual(shares(p), [["Ali", "loser", 17500], ["Guest", "winner", 0], ["Bilal", "loser", 17500]]);
  const t = (await billMatch(team)).body.data;
  assert.deepEqual([t.gameMode, t.total, t.winningTeam, t.losingTeam], ["four_player", 50000, 1, 2]);
  // The losing team (Team 2: Bilal and Usman) pays, in equal parts
  assert.deepEqual(t.players.map((p) => [p.name, p.team, p.result, p.shareAmount]),
    [["Ali", 1, "winner", 0], ["Ahmed", 1, "winner", 0], ["Bilal", 2, "loser", 25000], ["Usman", 2, "loser", 25000]]);
});

test("payer rules on the match result: loser pays / winner pays / both pay, for 3 players and for teams; shares add up exactly", async () => {
  await ok("PATCH", "/settings", { body: { gameRates: { snooker_point: 35001, four_player: 50001 } } }); // odd paisa on purpose
  const session = await openSession();
  const point = await playMatch(session, "snooker_point", [walkIn("A"), walkIn("B"), walkIn("C")], { winnerSeat: 3 });
  const team = await playMatch(session, "four_player", four(["T1a", "T1b", "T2a", "T2b"]), { winningTeam: 2 });
  await endSession(session, 20 * 60);
  const cases = [
    [point, "loser", [17501, 17500, 0]],
    [point, "winner", [0, 0, 35001]],
    [point, "split", [11667, 11667, 11667]],
    [team, "loser", [25001, 25000, 0, 0]],   // Team 1 lost
    [team, "winner", [0, 0, 25001, 25000]],  // Team 2 won
    [team, "split", [12501, 12500, 12500, 12500]],
  ];
  for (const [match, payerRule, expected] of cases) {
    const preview = await previewMatch(match, { payerRule });
    assert.deepEqual(preview.players.map((p) => p.shareAmount), expected, `${match.gameMode} ${payerRule}`);
    assert.equal(sum(preview), preview.total, "parts add up to the total");
  }
  await ok("PATCH", "/settings", { body: { gameRates: RATES } });
});

// ---------------------------------------------------------------------------
// Refusals, duplicates, concurrency
// ---------------------------------------------------------------------------

test("only completed matches of an ended session can be billed; one bill per match", async () => {
  const session = await openSession();
  const running = await playMatch(session, "frame", [walkIn("A"), walkIn("B")]);
  const done = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const cancelled = await playMatch(session, "frame", [walkIn("A"), walkIn("B")]);
  await ok("POST", `/matches/${cancelled.id}/cancel`, { body: {} });

  const stillOpen = await billMatch(done);
  assert.deepEqual([stillOpen.status, stillOpen.body.message], [409, `The session on Table ${session.tableNumber} is still running. End it before billing its matches.`]);
  await endSession(session, 20 * 60);
  const refusals = [
    [await billMatch(running), "Match #1 must be completed before it can be billed (it is still in progress)."],
    [await billMatch(cancelled), "Match #3 must be completed before it can be billed (it is cancelled)."],
  ];
  for (const [response, message] of refusals) assert.deepEqual([response.status, response.body.message], [409, message]);
  const first = await billMatch(done);
  assert.equal(first.status, 201);
  const again = await billMatch(done);
  assert.deepEqual([again.status, again.body.message], [409, `Match #2 already has bill ${first.body.data.billNumber}`]);
  assert.equal((await billMatch({ id: "0123456789abcdef01234567" })).status, 404);
  assert.equal((await api("GET", `/matches/${running.id}/bill`)).status, 404);
  assert.equal(await db().collection("bills").countDocuments({ session: oid(session.id) }), 1);
});

test("the game type, quantity and players can't be changed on a match bill", async () => {
  const session = await openSession();
  const match = await playMatch(session, "frame", [reg(ali), reg(ahmed)], { winnerSeat: 1 });
  await endSession(session, 20 * 60);
  for (const extra of [{ gameMode: "century" }, { quantity: 3 }, { players: [{ name: "X" }, { name: "Y" }] }, { sessionId: session.id }]) {
    const result = await billMatch(match, { payerRule: "loser", ...extra });
    assert.equal(result.status, 400, JSON.stringify(extra));
    assert.equal(result.body.message, "The game type, players and result come from the match and can't be changed on its bill");
  }
  assert.equal((await billMatch(match, {})).body.message, "Choose who pays");
  const bill = (await billMatch(match)).body.data;
  assert.deepEqual([bill.gameMode, bill.quantity], ["frame", 1]);
});

test("5 cashiers bill the same match at once -> exactly one bill", async () => {
  const session = await openSession();
  const match = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await endSession(session, 20 * 60);
  const results = await Promise.all(Array.from({ length: 5 }, () => billMatch(match, { payerRule: "loser" }, cookies.cashier)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal(await db().collection("bills").countDocuments({ match: oid(match.id) }), 1);
});

test("century time is charged once per session: a second Century bill in the same session is refused", async () => {
  const session = await openSession();
  const one = await playMatch(session, "century", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const two = await playMatch(session, "century", [walkIn("A"), walkIn("B")], { winnerSeat: 2 });
  const frame = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 2 });
  await endSession(session, 30 * 60);
  const first = (await billMatch(one)).body.data;
  const second = await billMatch(two);
  assert.equal(second.status, 409);
  assert.equal(second.body.message, `This session's time was already charged on bill ${first.billNumber} (Century match #1). Century is charged by the session's time, so a session can have only one Century bill.`);
  assert.equal((await billMatch(frame)).status, 201, "other modes still bill");
  // At the same moment: the database index lets only one through
  const s2 = await openSession();
  const x = await playMatch(s2, "century", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const y = await playMatch(s2, "century", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await endSession(s2, 30 * 60);
  const raced = await Promise.all([billMatch(x), billMatch(y)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
});

// ---------------------------------------------------------------------------
// Rate snapshot, result correction
// ---------------------------------------------------------------------------

test("rate snapshot: today's rate when the bill is made (not when the match started); later changes never alter it; Rs 0 refused", async () => {
  const session = await openSession();
  const match = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const off = await playMatch(session, "snooker_point", [walkIn("A"), walkIn("B"), walkIn("C")], { winnerSeat: 1 });
  await ok("PATCH", "/settings", { body: { gameRates: { frame: 30000 } } }); // changed after the match started
  await endSession(session, 20 * 60);
  const bill = (await billMatch(match)).body.data;
  assert.equal(bill.unitPrice, 30000);
  await ok("PATCH", "/settings", { body: { gameRates: { frame: 99900 } } });
  const again = await ok("GET", `/bills/${bill.id}`);
  assert.deepEqual([again.unitPrice, again.total], [30000, 30000]);

  await ok("PATCH", "/settings", { body: { gameRates: { snooker_point: 0 } } });
  const refused = await billMatch(off);
  assert.deepEqual([refused.status, refused.body.message], [409, "Set the snooker point price in Settings before creating snooker point bills"]);
  assert.equal(await db().collection("bills").countDocuments({ match: oid(off.id) }), 0);
  await ok("PATCH", "/settings", { body: { gameRates: RATES } });
});

test("changing the match result later never changes its bill", async () => {
  const session = await openSession();
  const match = await playMatch(session, "frame", [reg(ali), reg(ahmed)], { winnerSeat: 1 });
  await endSession(session, 20 * 60);
  const bill = (await billMatch(match)).body.data; // Ahmed lost -> Ahmed pays
  await ok("POST", `/matches/${match.id}/result`, { body: { winnerSeat: 2 } });
  assert.deepEqual((await ok("GET", `/matches/${match.id}`)).players.map((p) => p.result), ["loser", "winner"]);
  const after = await ok("GET", `/bills/${bill.id}`);
  assert.deepEqual(shares(after), [["Ali", "winner", 0], ["Ahmed", "loser", 25000]], "the bill keeps the result it was made with");
});

test("name copies: renaming or deactivating a registered player doesn't change the bill", async () => {
  const kamran = await ok("POST", "/players", { body: { name: "Kamran" } });
  const session = await openSession();
  const match = await playMatch(session, "frame", [reg(kamran), walkIn("Walk In")], { winnerSeat: 2 });
  await endSession(session, 20 * 60);
  const bill = (await billMatch(match)).body.data;
  await ok("PATCH", `/players/${kamran.id}`, { body: { name: "Kamran Khan" } });
  await ok("POST", `/players/${kamran.id}/deactivate`);
  const again = await ok("GET", `/bills/${bill.id}`);
  assert.deepEqual(again.players.map((p) => [p.name, p.player || null]), [["Kamran", kamran.id], ["Walk In", null]]);
  assert.equal(await db().collection("players").countDocuments({ name: "Walk In" }), 0);
});

// ---------------------------------------------------------------------------
// Payments, cancel
// ---------------------------------------------------------------------------

test("payments work on match bills (per player); cancelling a match bill leaves the match completed", async () => {
  const session = await openSession();
  const match = await playMatch(session, "four_player", four(["P1", "P2", "P3", "P4"]), { winningTeam: 1 });
  const other = await playMatch(session, "frame", [walkIn("X"), walkIn("Y")], { winnerSeat: 1 });
  await endSession(session, 20 * 60);
  const bill = (await billMatch(match)).body.data; // P3 + P4 owe Rs 250 each
  const pay = await api("POST", `/bills/${bill.id}/payments`, { body: { amount: 25000, method: "cash", payerName: "p3" }, cookie: cookies.cashier });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.data.bill.status, "partially_paid");
  const wrong = await api("POST", `/bills/${bill.id}/payments`, { body: { amount: 100, method: "cash", payerName: "P1" } });
  assert.deepEqual([wrong.status, wrong.body.message], [409, "P1 doesn't owe anything on this bill"]);
  const last = await api("POST", `/bills/${bill.id}/payments`, { body: { amount: 25000, method: "card", payerName: "P4" } });
  assert.equal(last.body.data.bill.status, "paid");

  const toCancel = (await billMatch(other)).body.data;
  await ok("POST", `/bills/${toCancel.id}/cancel`, { body: { reason: "Mistake" } });
  const stays = await ok("GET", `/matches/${other.id}`);
  assert.deepEqual([stays.status, stays.bill], ["completed", toCancel.id], "the match is not reset or deleted");
  assert.equal((await billMatch(other)).status, 409, "like every bill, a cancelled bill isn't made again");
});

// ---------------------------------------------------------------------------
// Café
// ---------------------------------------------------------------------------

test("café: the session's tab goes onto ONE match bill, stock taken once; consumer keeps the registered player", async () => {
  const drinks = await ok("POST", "/categories", { body: { name: "Drinks" } });
  const cola = await ok("POST", "/products", { body: { name: "Cola", categoryId: drinks.id, price: 8000, stockQuantity: 10 } });
  const session = await openSession();
  const first = await playMatch(session, "frame", [reg(ali), walkIn("Guest")], { winnerSeat: 1 });
  const second = await playMatch(session, "frame", [reg(ali), walkIn("Guest")], { winnerSeat: 2 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 2, consumer: "ali" } });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 1, consumer: "Guest" } });
  await endSession(session, 30 * 60);

  // Consumer pays: each player pays for their own drinks
  const bill = (await billMatch(first, { payerRule: "loser", cafePayerRule: "consumer" })).body.data;
  const cafe = bill.lineItems.filter((l) => l.type === "cafe");
  assert.deepEqual(cafe.map((l) => [l.description, l.quantity, l.consumer, l.consumerPlayer || null]), [["Cola", 2, "Ali", ali.id], ["Cola", 1, "Guest", null]]);
  assert.deepEqual(bill.players.map((p) => [p.name, p.gameShare, p.cafeShare]), [["Ali", 0, 16000], ["Guest", 25000, 8000]]);
  assert.equal((await ok("GET", `/products/${cola.id}`)).stockQuantity, 7, "stock taken once");
  // The second frame's bill has no café: the tab items belong to the first bill
  const next = (await billMatch(second)).body.data;
  assert.deepEqual([next.lineItems.length, next.total], [1, 25000]);
  assert.equal((await ok("GET", `/products/${cola.id}`)).stockQuantity, 7);
  // The tab stays usable after match bills (the session wasn't billed as a whole)
  const tab = await ok("GET", `/sessions/${session.id}/cafe-items`);
  assert.equal(tab.billed, false);
  assert.ok(tab.items.every((i) => i.status === "billed" && i.bill === bill.id));
});

test("café: 'leave the tab for a later bill'; not enough stock blocks the whole bill; cancel puts stock back", async () => {
  const snacks = await ok("POST", "/categories", { body: { name: "Snacks" } });
  const chips = await ok("POST", "/products", { body: { name: "Chips", categoryId: snacks.id, price: 5000, stockQuantity: 3 } });
  const session = await openSession();
  const first = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const second = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: chips.id, quantity: 2 } });
  await endSession(session, 20 * 60);

  const noCafe = (await billMatch(first, { payerRule: "loser", includeCafeTab: false })).body.data;
  assert.equal(noCafe.lineItems.length, 1, "tab left open for a later bill");
  assert.equal((await ok("GET", `/products/${chips.id}`)).stockQuantity, 3);

  // Someone took stock meanwhile: 2 needed, 1 left -> no bill, nothing taken, tab still open
  await db().collection("products").updateOne({ _id: oid(chips.id) }, { $set: { stockQuantity: 1 } });
  const short = await billMatch(second);
  assert.equal(short.status, 409);
  assert.match(short.body.message, /Not enough stock: Chips has 1 left, this bill needs 2/);
  assert.equal(await db().collection("bills").countDocuments({ match: oid(second.id) }), 0);
  assert.equal((await ok("GET", `/products/${chips.id}`)).stockQuantity, 1);
  assert.ok((await ok("GET", `/sessions/${session.id}/cafe-items`)).items.every((i) => i.status === "open"));

  await db().collection("products").updateOne({ _id: oid(chips.id) }, { $set: { stockQuantity: 3 } });
  const withCafe = (await billMatch(second)).body.data;
  assert.equal(withCafe.total, 25000 + 10000);
  assert.equal((await ok("GET", `/products/${chips.id}`)).stockQuantity, 1);
  await ok("POST", `/bills/${withCafe.id}/cancel`, { body: {} });
  assert.equal((await ok("GET", `/products/${chips.id}`)).stockQuantity, 3, "cancel puts the stock back (Phase 10 rule)");
});

test("café: two matches of one session billed at the same moment never share (or double-take) the tab", async () => {
  const cat = await ok("POST", "/categories", { body: { name: "Tea" } });
  const tea = await ok("POST", "/products", { body: { name: "Green tea", categoryId: cat.id, price: 3000, stockQuantity: 10 } });
  const session = await openSession();
  const a = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const b = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  for (let i = 0; i < 3; i += 1) await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: tea.id, quantity: 1 } });
  await endSession(session, 20 * 60);
  await Promise.all([billMatch(a), billMatch(b)]);
  // Whatever happened, each tab item is on at most one bill and stock left = 10 - items really billed
  const bills = await db().collection("bills").find({ session: oid(session.id) }).toArray();
  const cafeLines = bills.flatMap((bill) => bill.lineItems.filter((l) => l.type === "cafe"));
  assert.ok(cafeLines.length <= 3);
  assert.equal(new Set(cafeLines.map((l) => String(l.cafeOrder))).size, cafeLines.length, "no item on two bills");
  assert.equal((await ok("GET", `/products/${tea.id}`)).stockQuantity, 10 - cafeLines.length);
  // Billing the remaining match(es) afterwards puts every item on exactly one bill
  for (const match of [a, b]) if (!bills.some((bill) => String(bill.match) === match.id)) assert.equal((await billMatch(match)).status, 201);
  const all = (await db().collection("bills").find({ session: oid(session.id) }).toArray()).flatMap((bill) => bill.lineItems.filter((l) => l.type === "cafe"));
  assert.equal(all.length, 3);
  assert.equal((await ok("GET", `/products/${tea.id}`)).stockQuantity, 7);
});

// ---------------------------------------------------------------------------
// Old bills and whole-session billing
// ---------------------------------------------------------------------------

test("whole-session billing still works for sessions without matches; the two kinds of bill never overlap", async () => {
  // A session without matches: the Create Bill window, exactly as before (no match link)
  const plain = await openSession();
  await endSession(plain, 47 * 60);
  const legacy = await ok("POST", "/bills", { body: { sessionId: plain.id, gameMode: "century", quantity: 1, payerRule: "loser",
    players: [{ name: "Ali" }, { name: "Usman", result: "loser" }] } });
  assert.deepEqual([legacy.match, legacy.matchNumber, legacy.total], [undefined, undefined, 50000]);
  assert.deepEqual(await ok("GET", `/sessions/${plain.id}/matches`), [], "no fake match created");
  assert.equal((await api("POST", "/bills", { body: { sessionId: plain.id, gameMode: "frame", quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] } })).body.message,
    `This session already has bill ${legacy.billNumber}`);
  await ok("POST", `/bills/${legacy.id}/payments`, { body: { amount: 50000, method: "cash", payerName: "Usman" } });

  // A session with matches: the whole-session bill is refused
  const withMatches = await openSession();
  const match = await playMatch(withMatches, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await endSession(withMatches, 20 * 60);
  const refused = await api("POST", "/bills/preview", { body: { sessionId: withMatches.id, gameMode: "frame", quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] } });
  assert.deepEqual([refused.status, refused.body.message], [409, `The session on Table ${withMatches.tableNumber} has matches. Bill each completed match from the Matches window.`]);
  assert.equal((await billMatch(match)).status, 201);

  // Only cancelled matches: the session can be billed as a whole again
  const onlyCancelled = await openSession();
  const dropped = await playMatch(onlyCancelled, "frame", [walkIn("A"), walkIn("B")]);
  await ok("POST", `/matches/${dropped.id}/cancel`, { body: {} });
  await endSession(onlyCancelled, 20 * 60);
  assert.equal((await api("POST", "/bills", { body: { sessionId: onlyCancelled.id, gameMode: "frame", quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] } })).status, 201);
});

test("an old bill stored before Phase 11.5 (no match field) is read and paid as before", async () => {
  const session = await openSession();
  await endSession(session, 20 * 60);
  const old = {
    billNumber: "B-20260801-0001", session: oid(session.id), tableNumber: session.tableNumber, tableName: "", sessionStartedAt: new Date("2026-08-01T10:00:00Z"),
    sessionEndedAt: new Date("2026-08-01T10:20:00Z"), durationSeconds: 1200, billedMinutes: 20, gameMode: "frame", quantity: 2, unitPrice: 15000,
    lineItems: [{ type: "game", description: "Frames", quantity: 2, unitPrice: 15000, amount: 30000 }],
    subtotal: 30000, taxEnabled: false, taxRateBasisPoints: 0, taxAmount: 0, total: 30000, payerRule: "split", cafePayerRule: null,
    players: [{ name: "A", result: null, shareAmount: 15000, paidAmount: 0 }, { name: "B", result: null, shareAmount: 15000, paidAmount: 0 }],
    amountPaid: 0, status: "unpaid", createdAt: new Date("2026-08-01T10:21:00Z"), updatedAt: new Date("2026-08-01T10:21:00Z"),
  };
  const { insertedId } = await db().collection("bills").insertOne(old);
  const bill = await ok("GET", `/bills/${insertedId}`);
  assert.deepEqual([bill.match, bill.total, bill.players.map((p) => p.shareAmount)], [undefined, 30000, [15000, 15000]]);
  assert.equal((await api("POST", `/bills/${insertedId}/payments`, { body: { amount: 15000, method: "cash", payerName: "A" } })).body.data.bill.status, "partially_paid");
  // The session history still shows it as the session's bill
  const row = (await ok("GET", "/sessions?status=completed&limit=100")).sessions.find((s) => s.id === session.id);
  assert.deepEqual([row.bill.billNumber, row.matches], ["B-20260801-0001", null]);
});

// ---------------------------------------------------------------------------
// One session, many bills: lists and reports
// ---------------------------------------------------------------------------

test("one session, many match bills: session history, dashboard and the tables report count every bill (time once)", async (testContext) => {
  // Anchored to the nearest club-local (Asia/Karachi) noon that is NOT before the real "now":
  // endSession() below backdates the session by 50 minutes from "now", and whenever this test
  // happens to run within 50 minutes of a real Asia/Karachi midnight, that lands the session on
  // the PREVIOUS club-local day - so the "today" report queries further down correctly (but
  // misleadingly, for this test's purpose) find nothing. Noon is a 12-hour safety margin from
  // either midnight. The anchor is never set to a moment BEFORE the real "now": an earlier
  // attempt that hardcoded a fixed past date made this test's own session look OLDER than
  // sessions genuinely created a moment earlier (in real time) by the tests before it in this
  // same file, pushing it out of the dashboard's "recent sessions" window - found and corrected
  // while verifying this fix, not assumed safe. Only Date is mocked (node:test's own
  // MockTimers, no new dependency), so every route handler in the same process sees this
  // consistently; it is restored automatically when the test finishes (node:test's own
  // documented behaviour - confirmed directly before relying on it).
  const realNow = new Date();
  let anchor = new Date(startOfDayInTimeZone(dateInTimeZone(realNow, "Asia/Karachi"), "Asia/Karachi").getTime() + 12 * 60 * 60 * 1000); // noon, club-local, today
  if (anchor.getTime() < realNow.getTime()) anchor = new Date(anchor.getTime() + 24 * 60 * 60 * 1000); // already past noon -> noon tomorrow instead
  testContext.mock.timers.enable({ apis: ["Date"] });
  testContext.mock.timers.setTime(anchor.getTime());

  await db().collection("bills").deleteMany({});
  await db().collection("payments").deleteMany({});
  const session = await openSession();
  const century = await playMatch(session, "century", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const frame = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const point = await playMatch(session, "snooker_point", [walkIn("A"), walkIn("B"), walkIn("C")], { winnerSeat: 1 });
  await playMatch(session, "frame", [walkIn("A"), walkIn("B")]); // still in progress
  await endSession(session, 50 * 60); // 50 billed minutes
  for (const match of [century, frame, point]) assert.equal((await billMatch(match)).status, 201);

  const row = (await ok("GET", "/sessions?status=completed&limit=100")).sessions.find((s) => s.id === session.id);
  assert.equal(row.bill, null, "no bill for the whole session");
  assert.deepEqual(row.matches, { total: 4, inProgress: 1, completed: 3, cancelled: 0, billed: 3 });
  const dash = (await ok("GET", "/dashboard/summary")).recentSessions.find((s) => s.id === session.id);
  assert.deepEqual(dash.matches.billed, 3);

  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  const tables = await ok("GET", `/reports/tables?from=${today}&to=${today}`);
  const t = tables.tables.find((x) => x.tableNumber === session.tableNumber);
  assert.deepEqual([t.billCount, t.revenue, t.billedMinutes, t.unbilledCount], [3, 50000 + 25000 + 35000, 50, 0]);
  const revenue = await ok("GET", `/reports/revenue?from=${today}&to=${today}`);
  assert.equal(revenue.summary.totalBilled, 110000);
  assert.equal(revenue.summary.billCount, 3);
});

test("permissions: every role can make and see match bills; logged out 401", async () => {
  const session = await openSession();
  const matches = [];
  for (let i = 0; i < 3; i += 1) matches.push(await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 }));
  await endSession(session, 20 * 60);
  for (const [i, role] of ["admin", "staff", "cashier"].entries()) {
    assert.equal((await billMatch(matches[i], { payerRule: "loser" }, cookies[role])).status, 201, role);
    assert.equal((await api("GET", `/matches/${matches[i].id}/bill`, { cookie: cookies[role] })).status, 200, role);
  }
  assert.equal((await api("POST", `/matches/${matches[0].id}/bill`, { body: { payerRule: "loser" }, cookie: null })).status, 401);
});
