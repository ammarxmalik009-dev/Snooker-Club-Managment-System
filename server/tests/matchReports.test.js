// Tests for Phase 11.7: the Matches and Players reports (and every game type in Reports).
//
//   Matches report: matches that STARTED in the period (Karachi club days), each with its bill.
//   Players report: registered players - completed matches that started in the period, and their
//                   OWN share of match bills CREATED in the period (the Phase 11.6 rules).
//
// Records are made through the REAL API (sessions, matches, results, bills, payments), then their
// moments are moved into September 2026, so the expected numbers never depend on today's date.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");

const TEST_DB_URI = process.env.MONGODB_MATCHREPORTS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_matchreports";
const karachi = (local) => new Date(`${local}+05:00`);
const RATES = { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 };
const SEP10 = { from: "2026-09-10", to: "2026-09-10" };

let server;
let baseUrl;
const cookies = {};
let tableNumber = 0;

async function api(method, path, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: response.status, body: json, text, headers: response.headers };
}
async function ok(method, path, options) {
  const result = await api(method, path, options);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${result.text}`);
  return result.body.data;
}
const report = async (name, params, cookie) => {
  const { status, body } = await api("GET", `/reports/${name}?${new URLSearchParams(params)}`, { cookie });
  assert.equal(status, 200, `${name}: ${JSON.stringify(body)}`);
  return body.data;
};
const csvLines = (text) => text.replace(/^﻿/, "").trim().split("\r\n");

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);

async function addTable(name) {
  tableNumber += 1;
  return ok("POST", "/tables", { body: { tableNumber, hourlyRate: 1, name: name || `T${tableNumber}` } });
}
const openSession = (table) => ok("POST", "/sessions", { body: { tableId: table.id } });
async function endSession(session, minutes = 20) {
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - minutes * 60000) } });
  return ok("POST", `/sessions/${session.id}/end`);
}
const walkIn = (name, extra = {}) => ({ playerId: null, name, ...extra });
const reg = (p, extra = {}) => ({ playerId: p.id, ...extra });
// A match started at a Karachi time; completed with `result`, or left in progress
async function matchAt(session, startedLocal, gameMode, players, result) {
  let match = await ok("POST", `/sessions/${session.id}/matches`, { body: { gameMode, players } });
  if (result) match = await ok("POST", `/matches/${match.id}/complete`, { body: result });
  await db().collection("matches").updateOne({ _id: oid(match.id) }, { $set: { startedAt: karachi(startedLocal) } });
  return match;
}
async function billAt(match, createdLocal, body = { payerRule: "loser" }) {
  const bill = await ok("POST", `/matches/${match.id}/bill`, { body });
  await db().collection("bills").updateOne({ _id: oid(bill.id) }, { $set: { createdAt: karachi(createdLocal) } });
  return bill;
}
const pay = (bill, payerName, amount) => ok("POST", `/bills/${bill.id}/payments`, { body: { amount, method: "cash", payerName } });

// ---------------------------------------------------------------------------
// The main data set: one session on Table A, 10 Sep 2026 (Karachi)
//   m1 Century  Ali (reg) beats Guest         bill Rs 200, made 12 Sep (after the period!) - Guest pays
//   m2 Frame    Ahmed beats Ali (both reg)    bill Rs 250, Ali paid Rs 100 -> partly paid
//   m3 Point    Ahmed beats A and C           bill Rs 350, A + C owe Rs 175 each
//   m4 4 Pl.    Team 2 (Ahmed, Zed) beat Team 1 (Ali, Mate)  bill Rs 500, Ali paid his Rs 250, Mate owes Rs 250
//   m5 Frame    cancelled
//   m6 Frame    completed, never billed
//   m7 Frame    completed, billed, bill cancelled
//   m8 Frame    still in progress
// Outside the period: a match at 9 Sep 23:59:59 and one at 11 Sep 00:00:00.
// Plus a whole-session bill (Create Bill window) on 10 Sep with a free-text player called "Ali".
// ---------------------------------------------------------------------------
const data = {};

async function seedMain() {
  data.tableA = await addTable("Alpha");
  data.ali = await ok("POST", "/players", { body: { name: "Ali" } });
  data.ahmed = await ok("POST", "/players", { body: { name: "Ahmed" } });
  data.idle = await ok("POST", "/players", { body: { name: "Idle Player" } }); // registered, never played
  const { ali, ahmed } = data;
  const s = await openSession(data.tableA);
  data.before = await matchAt(s, "2026-09-09T23:59:59", "frame", [walkIn("Early"), walkIn("Bird")], { winnerSeat: 1 });
  data.m1 = await matchAt(s, "2026-09-10T00:00:00", "century", [reg(ali), walkIn("Guest")], { winnerSeat: 1 });
  data.m2 = await matchAt(s, "2026-09-10T11:00:00", "frame", [reg(ali), reg(ahmed)], { winnerSeat: 2 });
  data.m3 = await matchAt(s, "2026-09-10T12:00:00", "snooker_point", [walkIn("A"), reg(ahmed), walkIn("C")], { winnerSeat: 2 });
  data.m4 = await matchAt(s, "2026-09-10T13:00:00", "four_player",
    [reg(ali, { team: 1 }), walkIn("Mate", { team: 1 }), reg(ahmed, { team: 2 }), walkIn("Zed", { team: 2 })], { winningTeam: 2 });
  data.m5 = await matchAt(s, "2026-09-10T14:00:00", "frame", [walkIn("X"), walkIn("Y")]);
  await ok("POST", `/matches/${data.m5.id}/cancel`, { body: { reason: "Left" } });
  data.m6 = await matchAt(s, "2026-09-10T15:00:00", "frame", [walkIn("P"), walkIn("Q")], { winnerSeat: 1 });
  data.m7 = await matchAt(s, "2026-09-10T16:00:00", "frame", [walkIn("R"), walkIn("S")], { winnerSeat: 1 });
  data.m8 = await matchAt(s, "2026-09-10T23:59:59", "frame", [walkIn("I"), walkIn("J")]);
  data.after = await matchAt(s, "2026-09-11T00:00:00", "frame", [walkIn("Late"), walkIn("Owl")], { winnerSeat: 1 });
  await endSession(s, 20); // 20 billed minutes -> Century Rs 200

  data.b1 = await billAt(data.m1, "2026-09-12T10:00:00");
  data.b2 = await billAt(data.m2, "2026-09-10T11:30:00");
  await pay(data.b2, "Ali", 10000);
  data.b3 = await billAt(data.m3, "2026-09-10T12:30:00");
  data.b4 = await billAt(data.m4, "2026-09-10T13:30:00");
  await pay(data.b4, "Ali", 25000);
  data.b7 = await billAt(data.m7, "2026-09-10T16:30:00");
  await ok("POST", `/bills/${data.b7.id}/cancel`, { body: { reason: "Mistake" } });
  data.bAfter = await billAt(data.after, "2026-09-11T00:30:00");

  // A whole-session bill (no matches): names only - must never count for the registered "Ali"
  const tableB = await addTable("Bravo");
  const plain = await openSession(tableB);
  await endSession(plain, 30);
  const old = await ok("POST", "/bills", {
    body: { sessionId: plain.id, gameMode: "frame", quantity: 1, payerRule: "loser", players: [{ name: "Ali", result: "loser" }, { name: "Zed" }] },
  });
  await db().collection("bills").updateOne({ _id: oid(old.id) }, { $set: { createdAt: karachi("2026-09-10T18:00:00") } });
  data.oldBill = old;
  data.tableB = tableB;
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
  await seedMain();
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
// Matches report
// ---------------------------------------------------------------------------

test("matches: every match that started in the period - statuses, billed / not billed / bill cancelled, money of their bills", async () => {
  const r = await report("matches", SEP10);
  assert.equal(r.hasData, true);
  assert.deepEqual(r.summary, {
    total: 8, completed: 6, inProgress: 1, cancelled: 1,
    billed: 4,          // m1-m4 (m1's bill was made on 12 Sep: it still belongs to its match)
    billCancelled: 1,   // m7
    notBilled: 1,       // m6
    registeredSlots: 6, // places in matches that weren't cancelled: m1 1, m2 2, m3 1, m4 2
    walkInSlots: 11,    // m1 1, m3 2, m4 2, m6 2, m7 2, m8 2 (cancelled m5 not counted)
    billTotal: 130000,  // 200 + 250 + 350 + 500 (the cancelled bill is never money)
    billPaid: 35000,    // 100 + 250
    billOutstanding: 95000,
    averageBill: 32500,
    registeredPercent: 35.3,
  });
  assert.equal(r.moneyNote.includes("day it started"), true);
});

test("matches: all four game types get a row (registry order), with their own counts and money", async () => {
  const r = await report("matches", SEP10);
  const row = (mode) => r.games.find((g) => g.gameMode === mode);
  assert.deepEqual(r.games.map((g) => g.gameMode), ["century", "frame", "snooker_point", "four_player"]);
  assert.deepEqual([row("century").total, row("century").billed, row("century").billTotal, row("century").billPaid], [1, 1, 20000, 0]);
  const frame = row("frame");
  assert.deepEqual([frame.total, frame.completed, frame.cancelled, frame.inProgress, frame.billed, frame.billCancelled, frame.notBilled, frame.billTotal, frame.billPaid],
    [5, 3, 1, 1, 1, 1, 1, 25000, 10000]);
  assert.deepEqual([row("snooker_point").total, row("snooker_point").billTotal, row("snooker_point").walkInSlots], [1, 35000, 2]);
  assert.deepEqual([row("four_player").total, row("four_player").billTotal, row("four_player").billPaid, row("four_player").billOutstanding], [1, 50000, 25000, 25000]);
  // The game types sum to the summary
  for (const key of ["total", "billed", "billTotal", "billPaid", "registeredSlots", "walkInSlots"]) {
    assert.equal(r.games.reduce((sum, g) => sum + g[key], 0), r.summary[key], key);
  }
  // An empty period still lists the four game types, with real zeros
  const empty = await report("matches", { from: "2026-08-01", to: "2026-08-01" });
  assert.equal(empty.hasData, false);
  assert.deepEqual(empty.games.map((g) => [g.gameMode, g.total, g.billTotal, g.averageBill]),
    [["century", 0, 0, null], ["frame", 0, 0, null], ["snooker_point", 0, 0, null], ["four_player", 0, 0, null]]);
  assert.deepEqual([empty.matches, empty.summary.registeredPercent, empty.pagination.pages], [[], null, 1]);
});

test("matches: one row per match - number, time, table, game, players, result, status and the bill", async () => {
  const r = await report("matches", SEP10);
  assert.deepEqual(r.matches.map((m) => m.id), [data.m8, data.m7, data.m6, data.m5, data.m4, data.m3, data.m2, data.m1].map((m) => m.id), "newest first");
  const row = (m) => r.matches.find((x) => x.id === m.id);
  const m4 = row(data.m4);
  assert.deepEqual([m4.number, m4.gameMode, m4.status, m4.tableNumber, m4.tableName, m4.startedAt], [5, "four_player", "completed", data.tableA.tableNumber, "Alpha", karachi("2026-09-10T13:00:00").toISOString()]);
  assert.equal(m4.playersText, "Team 1: Ali & Mate vs Team 2: Ahmed & Zed");
  assert.equal(m4.resultText, "Winning team: Team 2 (Ahmed & Zed)");
  assert.deepEqual(m4.players.map((p) => `${p.name}:${p.registered}:${p.team}:${p.result}`), ["Ali:true:1:loser", "Mate:false:1:loser", "Ahmed:true:2:winner", "Zed:false:2:winner"]);
  assert.deepEqual(m4.bill, { id: data.b4.id, billNumber: data.b4.billNumber, status: "partially_paid", total: 50000, amountPaid: 25000, balanceDue: 25000 });
  assert.deepEqual([row(data.m1).resultText, row(data.m1).bill.billNumber, row(data.m1).bill.status], ["Winner: Ali", data.b1.billNumber, "unpaid"]);
  assert.deepEqual([row(data.m3).playersText, row(data.m3).resultText], ["A vs Ahmed vs C", "Winner: Ahmed"]);
  assert.deepEqual([row(data.m5).status, row(data.m5).resultText, row(data.m5).cancelReason, row(data.m5).bill], ["cancelled", "Cancelled", "Left", null]);
  assert.deepEqual([row(data.m6).resultText, row(data.m6).bill], ["Winner: P", null], "completed, not billed");
  assert.deepEqual([row(data.m7).bill.status, row(data.m7).bill.balanceDue], ["cancelled", 0]);
  assert.deepEqual([row(data.m8).status, row(data.m8).resultText], ["in_progress", "In progress"]);
});

test("matches: Karachi club days - 00:00:00 and 23:59:59 are inside, the day before and after are not; presets and custom periods", async () => {
  const sep10 = await report("matches", SEP10);
  const ids = sep10.matches.map((m) => m.id);
  assert.ok(ids.includes(data.m1.id) && ids.includes(data.m8.id), "00:00:00 and 23:59:59 belong to 10 Sep");
  assert.ok(!ids.includes(data.before.id) && !ids.includes(data.after.id), "9 Sep 23:59:59 and 11 Sep 00:00:00 don't");
  const three = await report("matches", { from: "2026-09-09", to: "2026-09-11" });
  assert.equal(three.summary.total, 10);
  assert.equal((await report("matches", { from: "2026-09-11", to: "2026-09-11" })).summary.total, 1);
  for (const preset of ["today", "yesterday", "last7", "last30", "thisMonth", "prevMonth"]) {
    const r = await report("matches", { preset });
    assert.equal(r.range.preset, preset);
  }
  const tooLong = await api("GET", "/reports/matches?from=2025-01-01&to=2026-09-10");
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.message, /at most 366 days/);
});

test("matches: sorting and paging; the summary always covers every match", async () => {
  const oldest = await report("matches", { ...SEP10, sort: "oldest", limit: 3 });
  assert.deepEqual(oldest.matches.map((m) => m.id), [data.m1.id, data.m2.id, data.m3.id]);
  assert.deepEqual(oldest.pagination, { page: 1, limit: 3, total: 8, pages: 3 });
  const last = await report("matches", { ...SEP10, sort: "oldest", limit: 3, page: 3 });
  assert.deepEqual([last.matches.map((m) => m.id), last.summary.total], [[data.m7.id, data.m8.id], 8]);
  assert.equal((await api("GET", "/reports/matches?sort=random")).status, 400);
  assert.equal((await api("GET", "/reports/matches?page=0")).status, 400);
});

test("matches: filters - table and every game type; filters that don't fit matches are not applied", async () => {
  const tableC = await addTable("Charlie");
  const s = await openSession(tableC);
  const other = await matchAt(s, "2026-09-10T10:00:00", "snooker_point", [walkIn("U"), walkIn("V"), walkIn("W")], { winnerSeat: 1 });
  await endSession(s);
  const all = await report("matches", SEP10);
  assert.equal(all.summary.total, 9);
  const onC = await report("matches", { ...SEP10, tableId: tableC.id });
  assert.deepEqual([onC.summary.total, onC.matches.map((m) => m.id)], [1, [other.id]]);
  assert.equal((await report("matches", { ...SEP10, tableId: data.tableA.id })).summary.total, 8);
  const counts = {};
  for (const mode of ["century", "frame", "snooker_point", "four_player"]) {
    const r = await report("matches", { ...SEP10, gameMode: mode });
    counts[mode] = r.summary.total;
    assert.ok(r.matches.every((m) => m.gameMode === mode));
    assert.deepEqual(r.games.map((g) => g.gameMode), [mode], "only the chosen game type");
  }
  assert.deepEqual(counts, { century: 1, frame: 5, snooker_point: 2, four_player: 1 });
  // Payment method, bill status and booking status don't describe a match: the report ignores them
  const ignored = await report("matches", { ...SEP10, method: "card", billStatus: "paid", bookingStatus: "no_show" });
  assert.deepEqual(ignored.summary, all.summary);
  await db().collection("matches").deleteOne({ _id: oid(other.id) }); // back to the main data set
});

test("matches: old / whole-session bills never get a match invented; nothing is written by the report", async () => {
  const before = await db().collection("matches").countDocuments();
  const billsBefore = JSON.stringify(await db().collection("bills").find().sort({ _id: 1 }).toArray());
  const r = await report("matches", SEP10);
  assert.ok(!r.matches.some((m) => m.bill && m.bill.id === data.oldBill.id), "the whole-session bill is no match");
  assert.equal(await db().collection("matches").countDocuments(), before);
  assert.equal(JSON.stringify(await db().collection("bills").find().sort({ _id: 1 }).toArray()), billsBefore, "bills unchanged");
  // ...but the whole-session bill is still revenue, exactly as before
  const revenue = await report("revenue", SEP10);
  assert.equal(revenue.summary.totalBilled, 25000 + 35000 + 50000 + 25000); // b2, b3, b4 + the whole-session Frame (b7 cancelled)
});

// ---------------------------------------------------------------------------
// Players report
// ---------------------------------------------------------------------------

test("players: registered players only - played, wins, losses; their OWN share, paid and outstanding on bills made in the period", async () => {
  const r = await report("players", SEP10);
  const row = (p) => r.players.find((x) => x.playerId === p.id);
  assert.deepEqual(r.players.map((p) => p.name).sort(), ["Ahmed", "Ali"], "Idle Player (no activity) isn't listed");
  // Ali: m1 won, m2 lost, m4 lost (team). Bills made on 10 Sep: m2 (share Rs 250, paid Rs 100) and m4
  // (share Rs 250, paid). m1's bill was made on 12 Sep -> not in this period's money.
  assert.deepEqual(row(data.ali), {
    playerId: data.ali.id, name: "Ali", isActive: true, matches: 3, wins: 1, losses: 2, winPercent: 33.3,
    bills: 2, cancelledBills: 0, openBills: 1, billed: 50000, paid: 35000, outstanding: 15000,
  });
  // Ahmed won m2, m3 and m4: on the bills, but owes nothing
  assert.deepEqual([row(data.ahmed).matches, row(data.ahmed).wins, row(data.ahmed).losses, row(data.ahmed).winPercent,
    row(data.ahmed).bills, row(data.ahmed).billed, row(data.ahmed).outstanding], [3, 3, 0, 100, 3, 0, 0]);
  // Team-mate's debt is NOT Ali's: Mate (walk-in) still owes Rs 250 on m4, Ali owes only his m2 balance
  assert.equal(row(data.ali).outstanding, 15000);
  // Walk-ins: one line, never a player. m1 Guest, m3 A + C, m4 Mate + Zed, m6 P + Q, m7 R + S
  assert.deepEqual(r.walkIns, {
    matches: 9, wins: 3, losses: 6, winPercent: 33.3,
    bills: 4,               // A, C, Mate, Zed on bills made on 10 Sep (m1's bill is 12 Sep; m7's is cancelled)
    cancelledBills: 2,      // R and S on the cancelled m7 bill
    openBills: 3,           // A, C, Mate still owe
    billed: 60000, paid: 0, outstanding: 60000,
  });
  // The whole-session bill with a free-text "Ali" (Rs 250, unpaid) is NOT Ali's and not a walk-in's
  assert.deepEqual(r.totals, { players: 2, billed: 50000, paid: 35000, outstanding: 15000 });
  assert.match(r.limitation, /keep player names only/);
  assert.equal(await db().collection("players").countDocuments(), 3, "no walk-in became a registered player");
});

test("players: the same numbers as the player's own history (Phase 11.6), over the same records", async () => {
  const r = await report("players", { from: "2026-09-01", to: "2026-09-30" }); // every bill of the data set
  const ali = r.players.find((p) => p.playerId === data.ali.id);
  const history = (await ok("GET", `/players/${data.ali.id}/bills`)).summary;
  const matches = (await ok("GET", `/players/${data.ali.id}/matches`)).stats;
  assert.deepEqual([ali.bills, ali.billed, ali.paid, ali.outstanding, ali.openBills], [history.bills, history.totalShare, history.totalPaid, history.outstanding, history.openBills]);
  assert.deepEqual([ali.matches, ali.wins, ali.losses], [matches.completed, matches.wins, matches.losses]);
  assert.equal(ali.bills, 3, "m1's bill (12 Sep) is in this longer period");
});

test("players: paid, partly paid and cancelled bills; renamed and inactive players keep their rows", async () => {
  await pay(data.b2, "Ali", 15000); // Ali pays the rest of m2
  await ok("PATCH", `/players/${data.ahmed.id}`, { body: { name: "Ahmed Raza" } });
  await ok("POST", `/players/${data.ahmed.id}/deactivate`);
  const r = await report("players", SEP10);
  const ali = r.players.find((p) => p.playerId === data.ali.id);
  const ahmed = r.players.find((p) => p.playerId === data.ahmed.id);
  assert.deepEqual([ali.paid, ali.outstanding, ali.openBills], [50000, 0, 0], "paid bills owe nothing");
  assert.deepEqual([ahmed.name, ahmed.isActive, ahmed.matches], ["Ahmed Raza", false, 3], "current name; inactive players are kept");
  // The cancelled m7 bill only had walk-ins: counted for them as cancelled, never as money
  assert.deepEqual([r.walkIns.cancelledBills, r.walkIns.billed], [2, 60000]);
  // Undo for the next tests
  await ok("POST", `/players/${data.ahmed.id}/reactivate`);
  await ok("PATCH", `/players/${data.ahmed.id}`, { body: { name: "Ahmed" } });
});

test("players: sorting, paging and filters (table, every game type)", async () => {
  const order = async (sort) => (await report("players", { ...SEP10, sort })).players.map((p) => p.name);
  assert.deepEqual(await order("matches"), ["Ahmed", "Ali"], "3 matches each: more wins first");
  assert.deepEqual(await order("wins"), ["Ahmed", "Ali"]);
  assert.deepEqual(await order("billed"), ["Ali", "Ahmed"]);
  assert.deepEqual(await order("name"), ["Ahmed", "Ali"]);
  const page2 = await report("players", { ...SEP10, sort: "billed", limit: 1, page: 2 });
  assert.deepEqual([page2.players.map((p) => p.name), page2.pagination, page2.totals.players], [["Ahmed"], { page: 2, limit: 1, total: 2, pages: 2 }, 2]);
  assert.equal((await api("GET", "/reports/players?sort=random")).status, 400);

  const point = await report("players", { ...SEP10, gameMode: "snooker_point" });
  assert.deepEqual(point.players.map((p) => [p.name, p.matches, p.wins, p.bills]), [["Ahmed", 1, 1, 1]]);
  assert.deepEqual([point.walkIns.matches, point.walkIns.billed], [2, 35000]);
  const four = await report("players", { ...SEP10, gameMode: "four_player" });
  assert.deepEqual(four.players.map((p) => [p.name, p.wins, p.losses, p.billed]).sort(), [["Ahmed", 1, 0, 0], ["Ali", 0, 1, 25000]]);
  const century = await report("players", { ...SEP10, gameMode: "century" });
  assert.deepEqual(century.players.map((p) => [p.name, p.matches, p.bills]), [["Ali", 1, 0]], "the century bill was made on 12 Sep");
  const otherTable = await report("players", { ...SEP10, tableId: data.tableB.id });
  assert.equal(otherTable.hasData, false, "Table Bravo only has a whole-session bill: no player activity");
});

test("players: an empty period answers with hasData false and zeros", async () => {
  const r = await report("players", { from: "2026-08-01", to: "2026-08-01" });
  assert.deepEqual([r.hasData, r.players, r.totals, r.walkIns.matches, r.walkIns.winPercent], [false, [], { players: 0, billed: 0, paid: 0, outstanding: 0 }, 0, null]);
});

// ---------------------------------------------------------------------------
// Every game type in Reports
// ---------------------------------------------------------------------------

test("game types: all four game types can be chosen as a filter, are offered, and appear in Game types, Revenue and Outstanding", async () => {
  const options = await report("options", {});
  assert.deepEqual(options.gameModes.slice(0, 4), ["century", "frame", "snooker_point", "four_player"]);
  const games = await report("games", SEP10);
  assert.deepEqual(games.games.map((g) => g.gameMode).sort(), ["four_player", "frame", "snooker_point"]);
  assert.deepEqual((await report("games", { ...SEP10, gameMode: "four_player" })).games.map((g) => [g.gameMode, g.totalBilled]), [["four_player", 50000]]);
  assert.equal((await report("revenue", { ...SEP10, gameMode: "snooker_point" })).summary.totalBilled, 35000);
  assert.deepEqual((await report("outstanding", { ...SEP10, gameMode: "snooker_point" })).bills.map((b) => b.billNumber), [data.b3.billNumber]);
  assert.equal((await api("GET", "/reports/games?gameMode=bowling")).status, 400);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test("CSV: Matches (one row per match) and Players (every player + walk-ins) - period, filters, safe escaping", async () => {
  const s = await openSession(data.tableA);
  const evil = await matchAt(s, "2026-09-20T10:00:00", "frame", [walkIn("=HYPERLINK(1)"), walkIn('Sam "the" Cue')], { winnerSeat: 2 });
  await endSession(s);

  const matches = await api("GET", "/reports/export/matches?from=2026-09-10&to=2026-09-10");
  assert.equal(matches.status, 200);
  assert.match(matches.headers.get("content-type"), /text\/csv/);
  assert.equal(matches.headers.get("content-disposition"), 'attachment; filename="matches_2026-09-10_to_2026-09-10.csv"');
  const lines = csvLines(matches.text);
  assert.equal(lines[0], "Started at,Table,Match,Game type,Status,Players,Registered players,Result,Bill,Bill status,Bill total (Rs),Paid (Rs),Remaining (Rs)");
  assert.equal(lines.length, 1 + 8, "one row per match");
  assert.equal(lines.find((l) => l.includes("four_player")),
    `2026-09-10 13:00,1 - Alpha,5,four_player,completed,Team 1: Ali & Mate vs Team 2: Ahmed & Zed,2,Winning team: Team 2 (Ahmed & Zed),${data.b4.billNumber},partially_paid,500.00,250.00,250.00`);
  assert.ok(lines.some((l) => l.endsWith(",frame,cancelled,X vs Y,0,Cancelled,,,,,")), "a cancelled match without a bill");
  const tricky = csvLines((await api("GET", "/reports/export/matches?from=2026-09-20&to=2026-09-20")).text)[1];
  assert.ok(tricky.includes(`"'=HYPERLINK(1) vs Sam ""the"" Cue"`), tricky);
  const filtered = csvLines((await api("GET", "/reports/export/matches?from=2026-09-10&to=2026-09-10&gameMode=snooker_point")).text);
  assert.equal(filtered.length, 2);

  const players = await api("GET", "/reports/export/players?from=2026-09-10&to=2026-09-10&sort=name");
  assert.equal(players.headers.get("content-disposition"), 'attachment; filename="players_2026-09-10_to_2026-09-10.csv"');
  assert.deepEqual(csvLines(players.text), [
    "Player,Status,Matches played,Wins,Losses,Win %,Bills,Billed (Rs),Paid (Rs),Outstanding (Rs)",
    "Ahmed,active,3,3,0,100,3,0.00,0.00,0.00",
    "Ali,active,3,1,2,33.3,2,500.00,500.00,0.00",
    "Walk-in players (not registered),,9,3,6,33.3,4,600.00,0.00,600.00",
  ]);
  await db().collection("matches").deleteOne({ _id: oid(evil.id) });
});

// ---------------------------------------------------------------------------
// Permissions and indexes
// ---------------------------------------------------------------------------

test("permissions: admin and staff see both reports and CSVs; cashier 403; logged out 401", async () => {
  for (const path of ["/reports/matches?preset=today", "/reports/players?preset=today", "/reports/export/matches?preset=today", "/reports/export/players?preset=today"]) {
    assert.equal((await api("GET", path, { cookie: cookies.admin })).status, 200, `admin ${path}`);
    assert.equal((await api("GET", path, { cookie: cookies.staff })).status, 200, `staff ${path}`);
    const cashier = await api("GET", path, { cookie: cookies.cashier });
    assert.equal(cashier.status, 403, `cashier ${path}`);
    assert.equal(cashier.body.message, "You don't have permission to do this.");
    assert.equal((await api("GET", path, { cookie: null })).status, 401, `logged out ${path}`);
  }
});

test("indexes: the new report queries use existing indexes (no new index needed)", async () => {
  const window = { $gte: karachi("2026-09-10T00:00:00"), $lt: karachi("2026-09-11T00:00:00") };
  const plan = async (collection, filter) => JSON.stringify(await db().collection(collection).find(filter).explain("queryPlanner"));
  const matches = await plan("matches", { gameMode: { $in: ["century", "frame", "snooker_point", "four_player"] }, startedAt: window });
  assert.ok(matches.includes("gameMode_1_startedAt_-1") && !matches.includes("COLLSCAN"), "matches by period: the {gameMode, startedAt} index");
  const completed = await plan("matches", { gameMode: { $in: ["century", "frame", "snooker_point", "four_player"] }, startedAt: window, status: "completed" });
  assert.ok(completed.includes("IXSCAN") && !completed.includes("COLLSCAN"));
  const bills = await plan("bills", { createdAt: window, match: { $type: "objectId" } });
  assert.ok(bills.includes("IXSCAN") && !bills.includes("COLLSCAN"), "match bills by period: an index");
  // The bill of each match is found by its _id (the $lookup uses the _id index)
  const byId = await plan("bills", { _id: oid(data.b2.id) });
  assert.ok(byId.includes("IDHACK") || byId.includes("IXSCAN") || byId.includes("EXPRESS_IXSCAN"));
});
