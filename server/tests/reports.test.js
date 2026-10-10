// Automatic tests for /api/reports (Phase 9).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.
//
// Records are created through the REAL API (tables, sessions, bills, payments, bookings), then
// their timestamps are moved into a fixed past period (September 2026), so the expected numbers
// never depend on today's date. Karachi is UTC+5 all year.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const { dateInTimeZone, startOfDayInTimeZone, shiftDate } = require("../utils/time");

const TEST_DB_URI = process.env.MONGODB_REPORTS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_reports";
const karachi = (local) => new Date(`${local}+05:00`); // "2026-09-10T00:00:00" Karachi -> UTC moment
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

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
const report = async (name, params, cookie) => {
  const { status, body } = await api("GET", `/reports/${name}?${new URLSearchParams(params)}`, { cookie });
  assert.equal(status, 200, `${name}: ${JSON.stringify(body)}`);
  return body.data;
};

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);

async function clearData() {
  for (const name of ["tables", "sessions", "bills", "payments", "counters", "customers", "bookings"]) {
    await db().collection(name).deleteMany({});
  }
  tableNumber = 0;
}

async function addTable(name) {
  tableNumber += 1;
  const table = (await api("POST", "/tables", { body: { tableNumber, hourlyRate: 99999, name: name || `T${tableNumber}` } })).body.data;
  // The table "existed" long before the test period (utilization starts counting from this date)
  await db().collection("tables").updateOne({ _id: oid(table.id) }, { $set: { createdAt: LONG_AGO } });
  return table;
}

// A finished session on a table, played between two Karachi times
async function sessionAt(table, startLocal, endLocal) {
  const startedAt = karachi(startLocal);
  const endedAt = karachi(endLocal);
  const seconds = (endedAt - startedAt) / 1000;
  const session = (await api("POST", "/sessions", { body: { tableId: table.id } })).body.data;
  // Start it "seconds ago" so the real end endpoint calculates the real duration...
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
  const ended = (await api("POST", `/sessions/${session.id}/end`)).body.data;
  // ...then move it into the test period (exact duration, not "a second more" from the real clock)
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt, endedAt, durationSeconds: seconds } });
  return ended;
}

// A bill for a session, created at a Karachi time
async function billFor(session, createdLocal, extra = {}) {
  const { status, body } = await api("POST", "/bills", {
    body: {
      sessionId: session.id, gameMode: "century", quantity: 1, payerRule: "loser",
      players: [{ name: "Ali" }, { name: "Usman", result: "loser" }], ...extra,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  await db().collection("bills").updateOne({ _id: oid(body.data.id) }, { $set: { createdAt: karachi(createdLocal) } });
  return body.data;
}

async function billAt(createdLocal, extra = {}, table = null) {
  const t = table || (await addTable());
  const session = await sessionAt(t, "2026-09-01T10:00:00", "2026-09-01T10:30:00");
  return billFor(session, createdLocal, extra);
}

async function payAt(bill, amount, paidLocal, method = "cash", payerName = "Usman") {
  const { status, body } = await api("POST", `/bills/${bill.id}/payments`, { body: { amount, method, payerName } });
  assert.equal(status, 201, JSON.stringify(body));
  await db().collection("payments").updateOne({ _id: oid(body.data.payment.id) }, { $set: { paidAt: karachi(paidLocal) } });
  return body.data.payment;
}

const cancelBill = (bill) => api("POST", `/bills/${bill.id}/cancel`, { body: {} });

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
  // Rate list: century Rs 10 per billed minute (Phase 11.3: a 30 min session = Rs 300), frame Rs 150
  await api("PATCH", "/settings", { body: { gameRates: { century: 1000 }, framePrice: 15000 } });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await dropTestDatabase();
  await mongoose.disconnect();
});

const SEP10 = { from: "2026-09-10", to: "2026-09-10" };
const REPORTS = ["revenue", "payments", "games", "matches", "players", "tables", "bookings", "customers", "outstanding"]; // matches, players: Phase 11.7

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("permissions: admin and staff may read every report, cashier gets 403, logged out gets 401", async () => {
  for (const name of [...REPORTS, "options"]) {
    const path = `/reports/${name}?from=2026-09-10&to=2026-09-10`;
    assert.equal((await api("GET", path, { cookie: cookies.admin })).status, 200, `admin ${name}`);
    assert.equal((await api("GET", path, { cookie: cookies.staff })).status, 200, `staff ${name}`);
    const cashier = await api("GET", path, { cookie: cookies.cashier });
    assert.equal(cashier.status, 403, `cashier ${name}`);
    assert.equal(cashier.body.message, "You don't have permission to do this.");
    const anonymous = await api("GET", path, { cookie: null });
    assert.equal(anonymous.status, 401, `logged out ${name}`);
    assert.equal(anonymous.body.message, "Please log in to continue.");
  }
  for (const name of ["revenue", "payments", "games", "tables", "bookings", "outstanding"]) {
    assert.equal((await api("GET", `/reports/export/${name}?from=2026-09-10&to=2026-09-10`, { cookie: cookies.cashier })).status, 403);
    assert.equal((await api("GET", `/reports/export/${name}?from=2026-09-10&to=2026-09-10`, { cookie: null })).status, 401);
    assert.equal((await api("GET", `/reports/export/${name}?from=2026-09-10&to=2026-09-10`, { cookie: cookies.staff })).status, 200);
  }
  // Report data is never cached
  assert.equal((await api("GET", "/reports/revenue")).headers.get("cache-control"), "no-store");
});

test("permissions: the Reports PAGE is refused by the server for cashiers", async () => {
  const page = (cookie) => fetch(`${baseUrl}/pages/reports.html`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  assert.equal((await page(cookies.admin)).status, 200);
  assert.equal((await page(cookies.staff)).status, 200);
  const cashier = await page(cookies.cashier);
  assert.equal(cashier.status, 302);
  assert.equal(cashier.headers.get("location"), "/pages/dashboard.html?denied=1");
  assert.match((await page(null)).headers.get("location"), /^\/pages\/login\.html\?next=/);
});

test("validation: bad periods and filters -> 400 with a clear message", async () => {
  const bad = async (query, message) => {
    const { status, body } = await api("GET", `/reports/revenue?${query}`);
    assert.equal(status, 400, query);
    assert.match(JSON.stringify(body), message, query);
  };
  await bad("preset=forever", /Period must be one of/);
  await bad("from=2026-09-10", /Choose both a From and a To date/);
  await bad("to=2026-09-10", /Choose both a From and a To date/);
  await bad("from=2026-09-10&to=2026-09-01", /To date cannot be before the From date/);
  await bad("from=2026-02-30&to=2026-03-01", /From date must be a date/);
  await bad("from=2025-01-01&to=2026-09-01", /at most 366 days/);
  await bad("from=2026-09-01&to=2026-09-10&tableId=abc", /Invalid table id/);
  await bad("gameMode=bowling", /Game type must be one of/);
  // Phase 11.7: every registry game type can be filtered (all four can be billed from matches)
  for (const mode of ["snooker_point", "four_player"]) {
    assert.equal((await api("GET", `/reports/revenue?from=2026-09-01&to=2026-09-10&gameMode=${mode}`)).status, 200, mode);
  }
  await bad("method=bitcoin", /Payment method must be one of/);
  assert.equal((await api("GET", "/reports/outstanding?sort=random")).status, 400);
  assert.equal((await api("GET", "/reports/tables?sort=random")).status, 400);
  assert.equal((await api("GET", "/reports/export/users")).status, 400);
});

// ---------------------------------------------------------------------------
// Date boundaries (Asia/Karachi)
// ---------------------------------------------------------------------------

test("dates: 00:00:00 and 23:59:59 Karachi are inside the day, the day before and after are not", async () => {
  await clearData();
  await billAt("2026-09-09T23:59:59"); // day before
  await billAt("2026-09-10T00:00:00"); // first second of 10 Sep
  await billAt("2026-09-10T23:59:59"); // last second of 10 Sep
  await billAt("2026-09-11T00:00:00"); // day after

  const day = await report("revenue", SEP10);
  assert.equal(day.summary.billCount, 2);
  assert.equal(day.summary.totalBilled, 60000);
  assert.equal(day.range.start, "2026-09-09T19:00:00.000Z", "10 Sep 00:00 Karachi = 9 Sep 19:00 UTC");
  assert.equal(day.range.end, "2026-09-10T19:00:00.000Z", "exclusive end: 11 Sep 00:00 Karachi");
  assert.deepEqual(day.days.map((d) => [d.date, d.billCount]), [["2026-09-10", 2]]);

  const three = await report("revenue", { from: "2026-09-09", to: "2026-09-11" });
  assert.equal(three.summary.billCount, 4);
  assert.deepEqual(three.days.map((d) => [d.date, d.billCount]), [["2026-09-09", 1], ["2026-09-10", 2], ["2026-09-11", 1]]);
  assert.equal(three.range.days, 3);

  assert.equal((await report("revenue", { from: "2026-09-12", to: "2026-09-30" })).summary.billCount, 0);
});

test("dates: presets 'today' and 'yesterday' use the club's business day", async () => {
  await clearData();
  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  const startOfToday = startOfDayInTimeZone(today, "Asia/Karachi");

  const todays = await billAt("2026-09-01T12:00:00");
  await db().collection("bills").updateOne({ _id: oid(todays.id) }, { $set: { createdAt: startOfToday } }); // 00:00:00 today
  const yesterdays = await billAt("2026-09-01T12:00:00");
  await db().collection("bills").updateOne({ _id: oid(yesterdays.id) }, { $set: { createdAt: new Date(startOfToday - 1000) } }); // 23:59:59 yesterday

  const t = await report("revenue", { preset: "today" });
  assert.deepEqual([t.range.from, t.range.to, t.range.preset], [today, today, "today"]);
  assert.equal(t.summary.billCount, 1);
  const y = await report("revenue", { preset: "yesterday" });
  assert.equal(y.range.from, shiftDate(today, -1));
  assert.equal(y.summary.billCount, 1);

  const week = await report("revenue", { preset: "last7" });
  assert.deepEqual([week.range.from, week.range.to, week.days.length], [shiftDate(today, -6), today, 7]);
  assert.equal(week.summary.billCount, 2);
  const month = await report("revenue", { preset: "thisMonth" });
  assert.equal(month.range.from, `${today.slice(0, 7)}-01`);
  const prev = await report("revenue", { preset: "prevMonth" });
  assert.equal(prev.range.to, shiftDate(`${today.slice(0, 7)}-01`, -1));
  assert.equal(prev.range.from, `${prev.range.to.slice(0, 7)}-01`);
  assert.equal((await report("revenue", { preset: "last30" })).days.length, 30);
});

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

test("revenue: cancelled bills are not revenue; statuses, outstanding and % collected", async () => {
  await clearData();
  const paid = await billAt("2026-09-10T10:00:00");          // Rs 300, fully paid
  await payAt(paid, 30000, "2026-09-10T11:00:00");
  const partly = await billAt("2026-09-10T12:00:00");        // Rs 300, Rs 100 paid
  await payAt(partly, 10000, "2026-09-10T12:30:00");
  await billAt("2026-09-10T13:00:00");                       // Rs 300 unpaid
  const cancelled = await billAt("2026-09-10T14:00:00");     // Rs 300, cancelled
  assert.equal((await cancelBill(cancelled)).status, 200);

  const { summary, days, hasData } = await report("revenue", SEP10);
  assert.equal(hasData, true);
  assert.equal(summary.billCount, 3, "cancelled bill not counted as a bill");
  assert.equal(summary.cancelledCount, 1);
  assert.deepEqual([summary.paidCount, summary.partiallyPaidCount, summary.unpaidCount], [1, 1, 1]);
  assert.equal(summary.totalBilled, 90000, "cancelled Rs 300 left out");
  assert.equal(summary.totalPaid, 40000);
  assert.equal(summary.totalOutstanding, 50000);
  assert.equal(summary.collectedPercent, 44.4);
  assert.equal(summary.paymentsReceived, 40000);
  assert.equal(summary.paymentCount, 2);
  assert.deepEqual(days[0], { date: "2026-09-10", billCount: 3, cancelledCount: 1, billed: 90000, paid: 40000, outstanding: 50000, received: 40000, paymentCount: 2 });

  // Only cancelled bills -> no revenue, "0%" is not claimed
  const onlyCancelled = await report("revenue", { ...SEP10, billStatus: "cancelled" });
  assert.equal(onlyCancelled.summary.totalBilled, 0);
  assert.equal(onlyCancelled.summary.collectedPercent, null);
  assert.equal(onlyCancelled.summary.cancelledCount, 1);
});

test("revenue: historical bill prices never change when Settings change", async () => {
  await clearData();
  const bill = await billAt("2026-09-10T10:00:00", { gameMode: "frame", quantity: 3 }); // 3 x Rs 150 = Rs 450
  assert.equal(bill.total, 45000);
  const before = await report("revenue", SEP10);

  await api("PATCH", "/settings", { body: { gameRates: { century: 9990 }, centuryPrice: 99900, framePrice: 77700, taxEnabled: true, taxRateBasisPoints: 1600 } });
  const after = await report("revenue", SEP10);
  const games = await report("games", SEP10);
  await api("PATCH", "/settings", { body: { gameRates: { century: 1000 }, centuryPrice: 30000, framePrice: 15000, taxEnabled: false } });

  assert.deepEqual(after.summary, before.summary);
  assert.equal(after.summary.totalBilled, 45000);
  assert.equal(games.games[0].gameRevenue, 45000, "old frame price (Rs 150) kept");
});

test("revenue: table, game type and bill status filters", async () => {
  await clearData();
  const t1 = await addTable();
  const t2 = await addTable();
  await billAt("2026-09-10T10:00:00", {}, t1);                                 // century Rs 300 on T1
  await billAt("2026-09-10T11:00:00", { gameMode: "frame", quantity: 2 }, t2); // frame Rs 300 on T2
  const paid = await billAt("2026-09-10T12:00:00", {}, t2);                    // century on T2, paid
  await payAt(paid, 30000, "2026-09-10T12:10:00", "card");

  assert.equal((await report("revenue", { ...SEP10, tableId: t1.id })).summary.billCount, 1);
  const t2Report = await report("revenue", { ...SEP10, tableId: t2.id });
  assert.equal(t2Report.summary.billCount, 2);
  assert.equal(t2Report.summary.paymentsReceived, 30000, "payments filtered by the bill's table");
  assert.equal((await report("revenue", { ...SEP10, gameMode: "frame" })).summary.totalBilled, 30000);
  assert.equal((await report("revenue", { ...SEP10, billStatus: "paid" })).summary.billCount, 1);
  assert.equal((await report("revenue", { ...SEP10, tableId: t1.id })).summary.paymentsReceived, 0);
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

test("payments: totals per method from real payment records, payments today for older bills, date filter", async () => {
  await clearData();
  const old = await billAt("2026-09-05T20:00:00");     // bill from 5 Sep...
  await payAt(old, 10000, "2026-09-10T09:00:00", "jazzcash"); // ...partly paid on 10 Sep
  const fresh = await billAt("2026-09-10T10:00:00");
  await payAt(fresh, 20000, "2026-09-10T10:30:00", "cash");
  await payAt(fresh, 10000, "2026-09-10T23:59:59", "cash");
  await payAt(old, 5000, "2026-09-11T00:00:00", "card"); // next day: outside

  const data = await report("payments", SEP10);
  const byMethod = Object.fromEntries(data.methods.map((m) => [m.method, [m.count, m.amount]]));
  assert.deepEqual(byMethod, {
    cash: [2, 30000], card: [0, 0], jazzcash: [1, 10000], easypaisa: [0, 0], bank_transfer: [0, 0], other: [0, 0],
  });
  assert.deepEqual(data.totals, { count: 3, amount: 40000 });
  assert.deepEqual(data.forEarlierBills, { count: 1, amount: 10000 }, "money received on 10 Sep for the 5 Sep bill");
  assert.equal(data.methods.find((m) => m.method === "cash").sharePercent, 75);

  // Method filter
  const cash = await report("payments", { ...SEP10, method: "cash" });
  assert.deepEqual(cash.totals, { count: 2, amount: 30000 });
  // The next day only has the card payment
  const next = await report("payments", { from: "2026-09-11", to: "2026-09-11" });
  assert.deepEqual(next.totals, { count: 1, amount: 5000 });
  // A day without payments
  const none = await report("payments", { from: "2026-09-01", to: "2026-09-01" });
  assert.equal(none.hasData, false);
  assert.deepEqual(none.totals, { count: 0, amount: 0 });
});

// ---------------------------------------------------------------------------
// Game types
// ---------------------------------------------------------------------------

test("games: grouped by the game types really stored, with quantities, café and averages", async () => {
  await clearData();
  await billAt("2026-09-10T10:00:00", { gameMode: "century", quantity: 2 });     // Rs 300 (30 min × Rs 10; 11.3: games don't change the price)
  await billAt("2026-09-10T11:00:00", {
    gameMode: "century", quantity: 1, cafeItems: [{ description: "Tea", quantity: 2, unitPrice: 5000 }],
  });                                                                             // Rs 300 + Rs 100 café
  await billAt("2026-09-10T12:00:00", { gameMode: "frame", quantity: 4 });        // Rs 600
  const cancelled = await billAt("2026-09-10T13:00:00", { gameMode: "frame", quantity: 9 });
  await cancelBill(cancelled);

  const { games, hasData } = await report("games", SEP10);
  assert.equal(hasData, true);
  const byMode = Object.fromEntries(games.map((g) => [g.gameMode, g]));
  assert.deepEqual(Object.keys(byMode).sort(), ["century", "frame"], "no invented game types");
  assert.equal(byMode.century.billCount, 2);
  assert.equal(byMode.century.quantity, 3, "games played are still counted");
  assert.equal(byMode.century.gameRevenue, 60000);
  assert.equal(byMode.century.cafeRevenue, 10000);
  assert.equal(byMode.century.totalBilled, 70000);
  assert.equal(byMode.century.averageBill, 35000);
  assert.equal(byMode.frame.billCount, 1, "cancelled frame bill not counted");
  assert.equal(byMode.frame.cancelledCount, 1);
  assert.equal(byMode.frame.quantity, 4);
  assert.equal(byMode.frame.totalBilled, 60000);

  const onlyFrames = await report("games", { ...SEP10, gameMode: "frame" });
  assert.deepEqual(onlyFrames.games.map((g) => g.gameMode), ["frame"]);
  assert.deepEqual((await report("games", { from: "2026-09-01", to: "2026-09-01" })).games, []);
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test("tables: sessions, durations, billed time, revenue and utilization per table", async () => {
  await clearData();
  const vip = await addTable("VIP");
  const corner = await addTable("Corner");
  await addTable("Idle");

  // VIP: 10:00-12:00 (2 h century = 120 min × Rs 10 = Rs 1,200) and 23:00-01:00 across midnight (2 h, billed frame Rs 450)
  const s1 = await sessionAt(vip, "2026-09-10T10:00:00", "2026-09-10T12:00:00");
  await billFor(s1, "2026-09-10T12:00:00");
  const s2 = await sessionAt(vip, "2026-09-10T23:00:00", "2026-09-11T01:00:00");
  await billFor(s2, "2026-09-11T01:00:00", { gameMode: "frame", quantity: 3 });
  // Corner: 1 h, bill cancelled (no revenue), plus a session with no bill yet
  const s3 = await sessionAt(corner, "2026-09-10T15:00:00", "2026-09-10T16:00:00");
  await cancelBill(await billFor(s3, "2026-09-10T16:00:00"));
  await sessionAt(corner, "2026-09-10T18:00:00", "2026-09-10T18:30:00");
  // A session on another day (not counted in 10 Sep)
  await sessionAt(corner, "2026-09-12T10:00:00", "2026-09-12T11:00:00");

  const data = await report("tables", { ...SEP10, sort: "revenue" });
  const byName = Object.fromEntries(data.tables.map((t) => [t.tableName, t]));
  assert.deepEqual(data.tables.map((t) => t.tableName), ["VIP", "Corner", "Idle"], "sorted by revenue");

  assert.equal(byName.VIP.sessionCount, 2);
  assert.equal(byName.VIP.completedCount, 2);
  assert.equal(byName.VIP.playedSeconds, 4 * 3600);
  assert.equal(byName.VIP.averageSessionSeconds, 2 * 3600);
  assert.equal(byName.VIP.billedMinutes, 240);
  assert.equal(byName.VIP.revenue, 120000 + 45000, "revenue from the saved bills, not the table's hourly rate");
  // Utilization on 10 Sep: 2 h + the 1 h before midnight = 3 h of 24 h
  assert.equal(byName.VIP.occupiedSeconds, 3 * 3600);
  assert.equal(byName.VIP.availableSeconds, 24 * 3600);
  assert.equal(byName.VIP.utilizationPercent, 12.5);

  assert.equal(byName.Corner.sessionCount, 2);
  assert.equal(byName.Corner.revenue, 0, "cancelled bill is not revenue");
  assert.equal(byName.Corner.billedMinutes, 0);
  assert.equal(byName.Corner.unbilledCount, 1);
  assert.equal(byName.Corner.occupiedSeconds, 1.5 * 3600);

  assert.equal(byName.Idle.sessionCount, 0, "a real idle table, shown with real zeros");
  assert.equal(byName.Idle.averageSessionSeconds, null);
  assert.equal(byName.Idle.utilizationPercent, 0);

  assert.deepEqual((await report("tables", { ...SEP10, sort: "sessions" })).tables.map((t) => t.tableName).slice(0, 2), ["VIP", "Corner"]);
  assert.deepEqual((await report("tables", { ...SEP10, sort: "tableNumber" })).tables.map((t) => t.tableNumber), [1, 2, 3]);
  assert.equal(data.totals.revenue, 165000); // Rs 1,200 century (120 min, 11.3) + Rs 450 frame
  assert.equal(data.utilization.label, "Observed Utilization");
  assert.equal(data.utilization.isEstimate, true);

  // The next day: VIP's midnight session only counts the hour after midnight
  const next = await report("tables", { from: "2026-09-11", to: "2026-09-11" });
  const vipNext = next.tables.find((t) => t.tableName === "VIP");
  assert.equal(vipNext.sessionCount, 0, "the session STARTED on 10 Sep");
  assert.equal(vipNext.occupiedSeconds, 3600);

  // A table added during the period: utilization only counts from when it was added
  await db().collection("tables").updateOne({ _id: oid(vip.id) }, { $set: { createdAt: karachi("2026-09-10T12:00:00") } });
  const halfDay = (await report("tables", { ...SEP10, tableId: vip.id })).tables;
  assert.equal(halfDay.length, 1);
  assert.equal(halfDay[0].availableSeconds, 12 * 3600);

  // A deleted table keeps its history but gets no (made-up) utilization
  await db().collection("tables").deleteOne({ _id: oid(corner.id) });
  const deleted = (await report("tables", SEP10)).tables.find((t) => t.tableName === "Corner");
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.sessionCount, 2);
  assert.equal(deleted.utilizationPercent, null);
});

test("tables: Observed Utilization = recorded session time / elapsed period clock time (no opening hours assumed)", async () => {
  await clearData();
  const vip = await addTable("VIP");
  const late = await addTable("Late");     // added during the period
  const corner = await addTable("Corner"); // deleted later
  const future = await addTable("Future"); // added after the period
  const exact = (occupied, available) => Math.round((occupied / available) * 1000) / 10;

  // VIP: 2 h on 10 Sep, 2 h across midnight 10->11 Sep, 1 h on 11 Sep
  await sessionAt(vip, "2026-09-10T10:00:00", "2026-09-10T12:00:00");
  await sessionAt(vip, "2026-09-10T23:00:00", "2026-09-11T01:00:00");
  await sessionAt(vip, "2026-09-11T22:00:00", "2026-09-11T23:00:00");
  // Late: added 11 Sep 06:00, played 1 h
  await db().collection("tables").updateOne({ _id: oid(late.id) }, { $set: { createdAt: karachi("2026-09-11T06:00:00") } });
  await sessionAt(late, "2026-09-11T10:00:00", "2026-09-11T11:00:00");
  // Corner: 3 h on 10 Sep
  await sessionAt(corner, "2026-09-10T12:00:00", "2026-09-10T15:00:00");
  // Future: added on 20 Sep, so it did not exist in the period
  await db().collection("tables").updateOne({ _id: oid(future.id) }, { $set: { createdAt: karachi("2026-09-20T00:00:00") } });

  const both = await report("tables", { from: "2026-09-10", to: "2026-09-11" });
  const row = (data, name) => data.tables.find((t) => t.tableName === name);

  // 1. Exact maths: numerator = recorded time inside the period, denominator = elapsed clock time of the period
  assert.equal(row(both, "VIP").occupiedSeconds, 5 * 3600);
  assert.equal(row(both, "VIP").availableSeconds, 2 * 86400, "the whole 2-day period, nothing removed for opening hours");
  assert.equal(row(both, "VIP").utilizationPercent, exact(5 * 3600, 2 * 86400)); // 10.4
  assert.equal(row(both, "VIP").utilizationPercent, 10.4);
  assert.equal(both.utilization.measuredFrom, "2026-09-09T19:00:00.000Z", "10 Sep 00:00 Karachi");
  assert.equal(both.utilization.measuredUntil, "2026-09-11T19:00:00.000Z", "12 Sep 00:00 Karachi (exclusive end)");

  // 2. Across midnight: the session's time is split between the two days by the clock,
  //    while "sessions" counts it on the day it STARTED (the report's documented day rule)
  const day10 = await report("tables", { from: "2026-09-10", to: "2026-09-10" });
  const day11 = await report("tables", { from: "2026-09-11", to: "2026-09-11" });
  assert.equal(row(day10, "VIP").occupiedSeconds, 3 * 3600);
  assert.equal(row(day11, "VIP").occupiedSeconds, 2 * 3600);
  assert.equal(row(day10, "VIP").occupiedSeconds + row(day11, "VIP").occupiedSeconds, row(both, "VIP").occupiedSeconds, "no time lost or counted twice");
  assert.deepEqual([row(day10, "VIP").sessionCount, row(day11, "VIP").sessionCount], [2, 1]);
  assert.deepEqual([row(day10, "VIP").utilizationPercent, row(day11, "VIP").utilizationPercent], [12.5, 8.3]);

  // 3. Added during the period: measured only from 11 Sep 06:00 -> 18 h available
  assert.equal(row(both, "Late").availableSeconds, 18 * 3600);
  assert.equal(row(both, "Late").utilizationPercent, exact(3600, 18 * 3600)); // 5.6
  // ... and a table that didn't exist yet gets no percentage (not a fake 0%)
  assert.equal(row(both, "Future").availableSeconds, 0);
  assert.equal(row(both, "Future").utilizationPercent, null);

  // 4. Deleting a table keeps its history and doesn't change any other table
  const vipBefore = row(both, "VIP");
  await db().collection("tables").deleteOne({ _id: oid(corner.id) });
  const afterDelete = await report("tables", { from: "2026-09-10", to: "2026-09-11" });
  assert.deepEqual(row(afterDelete, "VIP"), vipBefore);
  assert.deepEqual([row(afterDelete, "Corner").deleted, row(afterDelete, "Corner").occupiedSeconds, row(afterDelete, "Corner").utilizationPercent], [true, 3 * 3600, null]);
  assert.equal(afterDelete.totals.occupiedSeconds, both.totals.occupiedSeconds, "its recorded time still counts in the totals");

  // 5. A RUNNING session counts up to now; time that hasn't happened yet is never counted
  const live = await addTable("Live");
  const session = (await api("POST", "/sessions", { body: { tableId: live.id } })).body.data;
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - 2 * 3600e3) } });
  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  const before = Date.now();
  const todayReport = await report("tables", { preset: "today" });
  const elapsedToday = (Date.now() - startOfDayInTimeZone(today, "Asia/Karachi").getTime()) / 1000;
  const liveRow = row(todayReport, "Live");
  const expectedOccupied = Math.min(2 * 3600, elapsedToday);
  assert.ok(Math.abs(liveRow.occupiedSeconds - expectedOccupied) <= 5, `running session counted up to now (${liveRow.occupiedSeconds} vs ${expectedOccupied})`);
  assert.ok(Math.abs(liveRow.availableSeconds - elapsedToday) <= 5, "today is only measured up to now, not to midnight");
  assert.ok(liveRow.utilizationPercent > 0 && liveRow.utilizationPercent <= 100);
  assert.ok(Math.abs(new Date(todayReport.utilization.measuredUntil).getTime() - before) < 10_000, "measured until now");
  // A period that hasn't started: nothing measured, no percentage
  const tomorrow = shiftDate(today, 1);
  const ahead = await report("tables", { from: tomorrow, to: tomorrow });
  assert.ok(ahead.tables.every((t) => t.utilizationPercent === null && t.occupiedSeconds === 0));
  await api("POST", `/sessions/${session.id}/end`);

  // 6. Wording: the API names it Observed Utilization and says it is an estimate
  assert.equal(both.utilization.label, "Observed Utilization");
  assert.equal(both.utilization.isEstimate, true);
  assert.equal(both.utilization.description,
    "Percentage of the selected period represented by recorded table use. This is an estimate because club opening hours and maintenance/closure time are not stored.");
  assert.match(both.utilization.numerator, /Recorded session time/);
  assert.match(both.utilization.denominator, /elapsed clock time/);
  // 7. No opening hours / maintenance / hourly rate anywhere in the calculation's inputs
  assert.ok(!/openingHours|maintenance(Seconds|Hours)|hourlyRate/i.test(JSON.stringify(both.tables)));
  const csvText = (await api("GET", "/reports/export/tables?from=2026-09-10&to=2026-09-11")).text;
  assert.match(csvText, /Observed utilization \(%, estimate\)/);
});

test("tables: Sessions count on the START day; Observed Utilization splits time across days (all date cases)", async () => {
  await clearData();
  const t = await addTable("T");
  const multi = await addTable("Multi");
  const early = await addTable("Early");
  const gone = await addTable("Gone");
  const HOUR = 3600;
  const row = (data, name) => data.tables.find((x) => x.tableName === name);
  const tablesFor = (from, to = from) => report("tables", { from, to });

  await sessionAt(t, "2026-09-10T10:00:00", "2026-09-10T11:00:00");     // inside one day (1 h)
  await sessionAt(t, "2026-09-10T23:00:00", "2026-09-11T01:00:00");     // across midnight (1 h + 1 h)
  await sessionAt(multi, "2026-09-12T20:00:00", "2026-09-14T04:00:00"); // across several days (4 h + 24 h + 4 h)
  await sessionAt(early, "2026-09-09T22:00:00", "2026-09-10T02:00:00"); // started BEFORE a 10 Sep report (2 h + 2 h)
  await sessionAt(gone, "2026-09-09T23:00:00", "2026-09-10T01:00:00");  // same, on a table deleted afterwards
  await db().collection("tables").deleteOne({ _id: oid(gone.id) });

  // ---- Single day: 10 Sep ----
  const d10 = await tablesFor("2026-09-10");
  assert.equal(row(d10, "T").sessionCount, 2, "both sessions started on 10 Sep");
  assert.equal(row(d10, "T").occupiedSeconds, 2 * HOUR, "1 h + the hour before midnight");
  assert.equal(row(d10, "Early").sessionCount, 0, "started on 9 Sep: not a 10 Sep session...");
  assert.equal(row(d10, "Early").occupiedSeconds, 2 * HOUR, "...but its 00:00-02:00 on 10 Sep is used time");
  const goneRow = row(d10, "Gone");
  assert.ok(goneRow, "a deleted table whose session ran into the period still has a row");
  assert.deepEqual([goneRow.deleted, goneRow.sessionCount, goneRow.occupiedSeconds, goneRow.utilizationPercent], [true, 0, HOUR, null]);
  assert.equal(d10.totals.occupiedSeconds, 2 * HOUR + 2 * HOUR + HOUR, "no used time lost from the totals");
  assert.equal(d10.totals.sessionCount, 2);

  // ---- The day after midnight: 11 Sep ----
  const d11 = await tablesFor("2026-09-11");
  assert.equal(row(d11, "T").sessionCount, 0, "the midnight session is NOT counted again on 11 Sep");
  assert.equal(row(d11, "T").occupiedSeconds, HOUR, "but its hour after midnight is");
  assert.equal(row(d11, "T").utilizationPercent, Math.round((HOUR / (24 * HOUR)) * 1000) / 10);

  // ---- A session over several selected days: 12-14 Sep ----
  const days = await Promise.all(["2026-09-12", "2026-09-13", "2026-09-14"].map((d) => tablesFor(d)));
  assert.deepEqual(days.map((d) => row(d, "Multi").sessionCount), [1, 0, 0], "counted once, on its start day");
  assert.deepEqual(days.map((d) => row(d, "Multi").occupiedSeconds), [4 * HOUR, 24 * HOUR, 4 * HOUR]);
  assert.equal(row(days[1], "Multi").utilizationPercent, 100, "in use the whole of 13 Sep");
  const span = await tablesFor("2026-09-12", "2026-09-14");
  assert.equal(row(span, "Multi").occupiedSeconds, 32 * HOUR, "the days add up exactly: nothing lost, nothing twice");
  assert.equal(row(span, "Multi").availableSeconds, 72 * HOUR);
  assert.equal(row(span, "Multi").sessionCount, 1);

  // ---- Report boundary: only the time inside the period counts ----
  const endsAfter = await tablesFor("2026-09-10"); // T's midnight session ends after this period
  assert.equal(row(endsAfter, "T").occupiedSeconds, 2 * HOUR);

  // ---- Whole range 9-14 Sep: every second exactly once, every session exactly once ----
  const all = await tablesFor("2026-09-09", "2026-09-14");
  const totalSessionTime = (1 + 2 + 32 + 4 + 2) * HOUR;
  assert.equal(all.totals.occupiedSeconds, totalSessionTime);
  assert.equal(all.totals.playedSeconds, totalSessionTime, "played time and used time agree when the range holds every session");
  assert.equal(all.totals.sessionCount, 5);

  // ---- A running session that started yesterday ----
  const live = await addTable("Live");
  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  const startOfToday = startOfDayInTimeZone(today, "Asia/Karachi");
  const session = (await api("POST", "/sessions", { body: { tableId: live.id } })).body.data;
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(startOfToday.getTime() - HOUR * 1000) } });
  const yesterday = await tablesFor(shiftDate(today, -1));
  assert.deepEqual([row(yesterday, "Live").sessionCount, row(yesterday, "Live").activeCount, row(yesterday, "Live").occupiedSeconds], [1, 1, HOUR],
    "yesterday: counted as a session there, and only its last hour of yesterday is used time");
  const todayReport = await tablesFor(today);
  const elapsed = (Date.now() - startOfToday.getTime()) / 1000;
  assert.equal(row(todayReport, "Live").sessionCount, 0, "not counted again today");
  assert.ok(Math.abs(row(todayReport, "Live").occupiedSeconds - elapsed) <= 5, "today: from midnight until now");
  const tomorrow = await tablesFor(shiftDate(today, 1));
  assert.equal(row(tomorrow, "Live").occupiedSeconds, 0, "no future time");
  assert.equal(row(tomorrow, "Live").utilizationPercent, null);
  await api("POST", `/sessions/${session.id}/end`);

  // ---- Wording: the API says how each column counts ----
  assert.deepEqual(d10.sessionCounting, {
    label: "Sessions",
    attributedTo: "startDate",
    description: "Counted on the day the session started.",
    definition: "Each session is counted once, on the club day (Karachi time) it started - even if it ended the next day. A session that started before the period isn't counted, though its time inside the period is part of Observed Utilization.",
  });
  assert.equal(d10.utilization.attributedTo, "timeWithinEachDay");
  assert.equal(d10.utilization.dayAllocation, "Recorded table-use time is split across calendar days. A session crossing midnight contributes time to both days.");
  assert.equal(d10.utilization.label, "Observed Utilization");
});

// ---------------------------------------------------------------------------
// Bookings & customers
// ---------------------------------------------------------------------------

const futureDay = () => shiftDate(dateInTimeZone(new Date(), "Asia/Karachi"), 3);
let bookingSlot = 0;

// A real booking made through the API, then moved into the test period with the given status
async function bookingAt(customerId, table, startLocal, status, extra = {}) {
  bookingSlot += 1;
  const hour = String(8 + (bookingSlot % 14)).padStart(2, "0");
  const { status: code, body } = await api("POST", "/bookings", {
    body: { customerId, tableId: table.id, date: shiftDate(futureDay(), Math.floor(bookingSlot / 14)), startTime: `${hour}:00`, durationMinutes: 60 },
  });
  assert.equal(code, 201, JSON.stringify(body));
  const startAt = karachi(startLocal);
  await db().collection("bookings").updateOne({ _id: oid(body.data.id) }, {
    $set: { startAt, endAt: new Date(startAt.getTime() + 3600e3), status, ...extra },
  });
  return body.data;
}

async function customer(name, createdLocal = "2026-01-01T00:00:00") {
  const created = (await api("POST", "/customers", { body: { name, phone: "0300-1234567" } })).body.data;
  await db().collection("customers").updateOne({ _id: oid(created.id) }, { $set: { createdAt: karachi(createdLocal) } });
  return created;
}

test("bookings: status counts, rates, days, auto no-show and filters", async () => {
  await clearData();
  const table = await addTable();
  const other = await addTable();
  const c = await customer("Booker");
  await bookingAt(c.id, table, "2026-09-10T00:00:00", "completed");
  await bookingAt(c.id, table, "2026-09-10T15:00:00", "completed");
  await bookingAt(c.id, table, "2026-09-10T17:00:00", "cancelled");
  await bookingAt(c.id, other, "2026-09-10T19:00:00", "no_show");
  await bookingAt(c.id, other, "2026-09-10T23:00:00", "confirmed"); // in the past -> automatic no-show
  await bookingAt(c.id, table, "2026-09-09T23:59:00", "completed"); // day before: outside
  await bookingAt(c.id, table, "2026-09-11T00:00:00", "cancelled"); // day after: outside

  const data = await report("bookings", SEP10);
  assert.deepEqual(data.counts, { total: 5, pending: 0, confirmed: 0, completed: 2, cancelled: 1, no_show: 2, checkedIn: 2, decided: 5 });
  assert.deepEqual(data.rates, { checkInPercent: 40, noShowPercent: 40, cancellationPercent: 20 });
  assert.equal(data.ratesAvailable, true);
  assert.equal(data.statusFilter, null);
  assert.equal(data.totalBookings, 5);
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].total, 5);

  // Two days: one row per day
  const two = await report("bookings", { from: "2026-09-10", to: "2026-09-11" });
  assert.deepEqual(two.days.map((d) => [d.date, d.total]), [["2026-09-10", 5], ["2026-09-11", 1]]);

  // Status filter (changed after Phase 9 review): narrows the summary too, and rates become unavailable
  const filtered = await report("bookings", { ...SEP10, bookingStatus: "no_show" });
  assert.equal(filtered.days[0].total, 2);
  assert.equal(filtered.counts.total, 2);
  assert.equal(filtered.ratesAvailable, false);
  // Table filter
  assert.equal((await report("bookings", { ...SEP10, tableId: other.id })).counts.total, 2);

  // Only upcoming (undecided) bookings -> no rates claimed
  const future = futureDay();
  const upcoming = await report("bookings", { from: future, to: shiftDate(future, 30) });
  assert.equal(upcoming.counts.decided, 0);
  assert.deepEqual(upcoming.rates, { checkInPercent: null, noShowPercent: null, cancellationPercent: null });
});

test("bookings: every status option filters summary, daily rows and CSV alike; rates only for All", async () => {
  await clearData();
  const a = await addTable();
  const b = await addTable();
  const c = await customer("Filter Test");
  const today = dateInTimeZone(new Date(), "Asia/Karachi");
  const day = (offset) => shiftDate(today, offset);
  const at = (offset, time) => `${day(offset)}T${time}:00`;

  // Past days (outcome known) and a future day (still to come). Pending/confirmed are in the FUTURE,
  // so the automatic no-show rule leaves them alone.
  const plan = [
    [a, at(-2, "10:00"), "completed"], [a, at(-2, "12:00"), "completed"], [b, at(-2, "14:00"), "cancelled"], [b, at(-2, "16:00"), "no_show"],
    [a, at(-1, "10:00"), "no_show"], [a, at(-1, "12:00"), "cancelled"],
    [a, at(2, "10:00"), "pending"], [b, at(2, "12:00"), "confirmed"], [b, at(2, "14:00"), "cancelled"], // a future booking cancelled already
    [a, at(-10, "10:00"), "completed"], // outside the period
  ];
  for (const [table, start, status] of plan) await bookingAt(c.id, table, start, status);
  const period = { from: day(-3), to: day(3) };
  const expected = { pending: 1, confirmed: 1, completed: 2, cancelled: 3, no_show: 2 };

  const csvRows = async (params) => {
    const response = await api("GET", `/reports/export/bookings?${new URLSearchParams(params)}`);
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes("0300"), "no phone numbers");
    return response.text.replace(/^﻿/, "").trim().split("\r\n").slice(1).map((line) => line.split(","));
  };

  // ---- All statuses: full counts, every status in the daily rows, real rates ----
  const all = await report("bookings", period);
  assert.equal(all.statusFilter, null);
  assert.equal(all.totalBookings, 9);
  assert.deepEqual(all.counts, { total: 9, ...expected, checkedIn: 2, decided: 7 });
  assert.equal(all.ratesAvailable, true);
  // eligible (known outcome) = 2 checked in + 3 cancelled + 2 no-show = 7
  assert.deepEqual(all.rates, { checkInPercent: 28.6, noShowPercent: 28.6, cancellationPercent: 42.9 });
  const allDays = all.days.filter((d) => d.total > 0);
  assert.deepEqual(allDays.map((d) => [d.date, d.total]), [[day(-2), 4], [day(-1), 2], [day(2), 3]]);
  assert.equal(allDays.reduce((sum, d) => sum + d.pending + d.confirmed + d.completed + d.cancelled + d.no_show, 0), 9);
  const allCsv = await csvRows(period);
  assert.equal(allCsv.length, 9);
  assert.deepEqual([...new Set(allCsv.map((row) => row[5]))].sort(), ["cancelled", "completed", "confirmed", "no_show", "pending"]);

  // ---- Each single status: only that status everywhere, rates null (never 0% or 100%) ----
  for (const [status, count] of Object.entries(expected)) {
    const one = await report("bookings", { ...period, bookingStatus: status });
    assert.equal(one.statusFilter, status);
    assert.equal(one.totalBookings, count, status);
    assert.equal(one.counts.total, count, status);
    for (const other of Object.keys(expected)) assert.equal(one.counts[other], other === status ? count : 0, `${status}: ${other}`);
    assert.equal(one.ratesAvailable, false, status);
    assert.deepEqual(one.rates, { checkInPercent: null, noShowPercent: null, cancellationPercent: null }, status);
    assert.equal(one.ratesNote, "Rates are shown only when All statuses is selected.");
    for (const d of one.days) {
      assert.equal(d.total, d[status], `${status} ${d.date}: only this status is counted`);
      for (const other of Object.keys(expected)) if (other !== status) assert.equal(d[other], 0, `${status} ${d.date}: ${other}`);
    }
    assert.equal(one.days.reduce((sum, d) => sum + d.total, 0), count);
    const rows = await csvRows({ ...period, bookingStatus: status });
    assert.equal(rows.length, count, `${status} CSV`);
    assert.ok(rows.every((row) => row[5] === status), `${status} CSV has only ${status} rows`);
  }

  // ---- Booking status together with the other filters ----
  const cancelledOnB = await report("bookings", { ...period, bookingStatus: "cancelled", tableId: b.id });
  assert.equal(cancelledOnB.totalBookings, 2, "status + table");
  assert.equal((await csvRows({ ...period, bookingStatus: "cancelled", tableId: b.id })).length, 2);
  const cancelledOneDay = await report("bookings", { from: day(-2), to: day(-2), bookingStatus: "cancelled" });
  assert.equal(cancelledOneDay.totalBookings, 1, "status + date");
  assert.equal((await csvRows({ from: day(-2), to: day(-2), bookingStatus: "cancelled" })).length, 1);
  // Filters that don't belong to bookings (game type, payment method, bill status) change nothing here
  const withOthers = await report("bookings", { ...period, bookingStatus: "no_show", gameMode: "frame", method: "cash", billStatus: "paid" });
  assert.equal(withOthers.totalBookings, 2);
  // A status with nothing in the period: zero, no data, still no rates
  const none = await report("bookings", { from: day(-1), to: day(-1), bookingStatus: "pending" });
  assert.deepEqual([none.totalBookings, none.hasData, none.ratesAvailable, none.rates.noShowPercent], [0, false, false, null]);
});

test("customers: new customers, booking-based activity, repeat customers, no invented revenue", async () => {
  await clearData();
  const table = await addTable();
  const regular = await customer("Regular", "2026-09-10T09:00:00"); // new in the period
  const once = await customer("Once", "2026-09-09T23:59:59");       // created the day before
  const flaky = await customer("Flaky", "2026-09-10T23:59:59");     // new in the period

  // Regular: 2 check-ins (repeat), each linked to a real session
  for (const start of ["2026-09-10T10:00:00", "2026-09-10T14:00:00"]) {
    const session = await sessionAt(table, start, start.replace(/T(\d\d)/, (m, h) => `T${String(Number(h) + 1).padStart(2, "0")}`));
    await bookingAt(regular.id, table, start, "completed", { session: oid(session.id), checkedInAt: karachi(start) });
  }
  await bookingAt(once.id, table, "2026-09-10T18:00:00", "completed");
  await bookingAt(flaky.id, table, "2026-09-10T20:00:00", "no_show");
  await bookingAt(flaky.id, table, "2026-09-10T21:00:00", "cancelled");
  await bookingAt(flaky.id, table, "2026-09-10T22:00:00", "cancelled");

  const data = await report("customers", SEP10);
  assert.deepEqual(data.stats, { newCustomers: 2, customersWithBookings: 3, customersCheckedIn: 2, repeatCustomers: 1 });
  assert.deepEqual(data.topByBookings.map((c) => [c.name, c.bookings]), [["Flaky", 3], ["Regular", 2], ["Once", 1]]);
  assert.deepEqual(data.topBySessions.map((c) => [c.name, c.sessions, c.playedSeconds]), [["Regular", 2, 7200]],
    "'Once' has a check-in but no session link: not counted as a session");
  assert.match(data.limitation, /not linked to customers/);
  const fieldNames = [...Object.keys(data.stats), ...data.topByBookings.flatMap(Object.keys)].join(" ");
  assert.ok(!/revenue|billed|paid|amount|phone/i.test(fieldNames), "no customer revenue or phone numbers in the report");
  assert.ok(!JSON.stringify(data).includes("0300"), "phone numbers not included");

  const empty = await report("customers", { from: "2026-08-01", to: "2026-08-01" });
  assert.equal(empty.hasData, false);
});

// ---------------------------------------------------------------------------
// Outstanding
// ---------------------------------------------------------------------------

test("outstanding: unpaid + partly paid only, sorting, totals, all dates and paging", async () => {
  await clearData();
  const unpaidOld = await billAt("2026-09-10T08:00:00", { gameMode: "frame", quantity: 1 }); // Rs 150 due
  const partly = await billAt("2026-09-10T12:00:00", { quantity: 3 });                      // Rs 300 (per minute, 11.3), Rs 100 paid -> Rs 200 due
  await payAt(partly, 10000, "2026-09-10T12:30:00");
  const unpaidNew = await billAt("2026-09-10T20:00:00");                                    // Rs 300 due
  const paid = await billAt("2026-09-10T13:00:00");
  await payAt(paid, 30000, "2026-09-10T13:30:00");
  await cancelBill(await billAt("2026-09-10T14:00:00"));
  await billAt("2026-09-05T10:00:00");                                                      // older, outside

  const oldest = await report("outstanding", SEP10);
  assert.deepEqual(oldest.bills.map((b) => b.billNumber), [unpaidOld, partly, unpaidNew].map((b) => b.billNumber));
  assert.deepEqual(oldest.totals, { count: 3, totalBilled: 75000, totalPaid: 10000, totalOutstanding: 65000, unpaidCount: 2, partiallyPaidCount: 1 });
  const row = oldest.bills[1];
  assert.deepEqual([row.total, row.amountPaid, row.balanceDue, row.status, row.players], [30000, 10000, 20000, "partially_paid", ["Ali", "Usman"]]);

  assert.deepEqual((await report("outstanding", { ...SEP10, sort: "newest" })).bills.map((b) => b.billNumber)[0], unpaidNew.billNumber);
  assert.deepEqual((await report("outstanding", { ...SEP10, sort: "balance" })).bills.map((b) => b.balanceDue), [30000, 20000, 15000]);
  assert.equal((await report("outstanding", { ...SEP10, billStatus: "partially_paid" })).totals.count, 1);
  assert.equal((await report("outstanding", { ...SEP10, billStatus: "paid" })).totals.count, 0, "paid bills are never outstanding");
  assert.equal((await report("outstanding", { ...SEP10, all: "true" })).totals.count, 4, "all dates includes the 5 Sep bill");

  const page2 = await report("outstanding", { ...SEP10, limit: 2, page: 2 });
  assert.equal(page2.bills.length, 1);
  assert.deepEqual(page2.pagination, { page: 2, limit: 2, total: 3, pages: 2 });

  // The same number as the revenue report's outstanding for the same day
  assert.equal((await report("revenue", SEP10)).summary.totalOutstanding, oldest.totals.totalOutstanding);
});

test("outstanding print: every matching bill (not one page), same filters and money as screen and CSV", async () => {
  await clearData();
  const main = await addTable("Main");
  const side = await addTable("Side");
  const at = (i) => `2026-09-10T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
  let i = 0;
  const unpaid = [];
  for (let n = 0; n < 26; n += 1) unpaid.push(await billAt(at(i++), {}, main));                  // 26 x Rs 300 due
  const partly = [];
  for (let n = 0; n < 3; n += 1) {                                                                // 3 x Rs 200 due
    const bill = await billAt(at(i++), {}, main);
    await payAt(bill, 10000, "2026-09-10T20:00:00");
    partly.push(bill);
  }
  const frames = [await billAt(at(i++), { gameMode: "frame", quantity: 1 }, side), await billAt(at(i++), { gameMode: "frame", quantity: 1 }, side)]; // 2 x Rs 150
  const paid = [await billAt(at(i++), {}, main), await billAt(at(i++), {}, main)];
  for (const bill of paid) await payAt(bill, 30000, "2026-09-10T21:00:00");
  const cancelled = await billAt(at(i++), {}, main);
  await cancelBill(cancelled);
  const older = await billAt("2026-09-05T10:00:00", {}, main);                                    // outside the period

  // Screen: pages of 25 (unchanged)
  const page1 = await report("outstanding", SEP10);
  const page2 = await report("outstanding", { ...SEP10, page: 2 });
  assert.deepEqual(page1.pagination, { page: 1, limit: 25, total: 31, pages: 2 });
  assert.equal(page1.bills.length, 25);
  assert.equal(page2.bills.length, 6);

  // Print: all 31, the same bills in the same order as page 1 + page 2
  const print = await report("outstanding/print", SEP10);
  const numbers = (list) => list.map((b) => b.billNumber);
  assert.equal(print.bills.length, 31);
  assert.deepEqual(numbers(print.bills), [...numbers(page1.bills), ...numbers(page2.bills)]);
  for (const bill of page2.bills) assert.ok(numbers(print.bills).includes(bill.billNumber), "page 2 bills are printed");
  assert.ok(print.bills.every((b) => ["unpaid", "partially_paid"].includes(b.status)));
  for (const excluded of [...paid, cancelled, older]) assert.ok(!numbers(print.bills).includes(excluded.billNumber), `${excluded.billNumber} not printed`);
  for (const included of [...unpaid, ...partly, ...frames]) assert.ok(numbers(print.bills).includes(included.billNumber));
  assert.deepEqual(print.totals, {
    count: 31, totalBilled: 26 * 30000 + 3 * 30000 + 2 * 15000, totalPaid: 3 * 10000,
    totalOutstanding: 26 * 30000 + 3 * 20000 + 2 * 15000, unpaidCount: 28, partiallyPaidCount: 3,
  });
  assert.equal(print.totals.totalOutstanding, page1.totals.totalOutstanding, "same total as the screen");
  assert.equal(print.totals.totalOutstanding, print.bills.reduce((sum, b) => sum + b.balanceDue, 0));
  assert.equal(print.maxRows, 2000);

  // Filters work exactly like the screen
  for (const [params, count] of [
    [{ tableId: side.id }, 2], [{ gameMode: "frame" }, 2], [{ billStatus: "partially_paid" }, 3], [{ billStatus: "unpaid" }, 28],
  ]) {
    const filtered = await report("outstanding/print", { ...SEP10, ...params });
    assert.equal(filtered.bills.length, count, JSON.stringify(params));
    assert.equal(filtered.totals.count, (await report("outstanding", { ...SEP10, ...params })).totals.count);
  }
  assert.equal((await report("outstanding/print", { ...SEP10, all: "true" })).bills.length, 32, "all dates adds the 5 Sep bill");
  assert.deepEqual((await report("outstanding/print", { ...SEP10, sort: "balance" })).bills.slice(0, 1).map((b) => b.balanceDue), [30000]);
  const sortedNewest = await report("outstanding/print", { ...SEP10, sort: "newest" });
  assert.equal(sortedNewest.bills[0].billNumber, frames[1].billNumber);

  // Nothing matches -> an empty, honest answer
  const empty = await report("outstanding/print", { ...SEP10, billStatus: "paid" });
  assert.deepEqual([empty.hasData, empty.bills.length, empty.totals.totalOutstanding], [false, 0, 0]);
  const emptyDay = await report("outstanding/print", { from: "2026-09-01", to: "2026-09-01" });
  assert.equal(emptyDay.hasData, false);

  // CSV still has exactly the same bills
  const csv = (await api("GET", `/reports/export/outstanding?${new URLSearchParams(SEP10)}`)).text.replace(/^﻿/, "").trim().split("\r\n").slice(1);
  assert.deepEqual(csv.map((line) => line.split(",")[0]), numbers(print.bills));

  // Same permissions as every report; nothing sensitive in the answer
  assert.equal((await api("GET", "/reports/outstanding/print", { cookie: cookies.cashier })).status, 403);
  assert.equal((await api("GET", "/reports/outstanding/print", { cookie: null })).status, 401);
  assert.equal((await api("GET", "/reports/outstanding/print", { cookie: cookies.staff })).status, 200);
  assert.ok(!/passwordHash|scrypt|token|phone|0300/i.test(JSON.stringify(print)));
});

test("outstanding print: the 2,000-bill safety limit refuses (never cuts short); CSV and paging unaffected", async () => {
  await clearData();
  const table = await addTable();
  const createdAt = karachi("2026-08-01T12:00:00");
  const rawBill = (n) => ({
    billNumber: `B-LIMIT-${String(n).padStart(5, "0")}`, session: new mongoose.Types.ObjectId(), table: oid(table.id),
    tableNumber: table.tableNumber, tableName: table.name, sessionStartedAt: createdAt, sessionEndedAt: createdAt,
    durationSeconds: 3600, billedMinutes: 60, gameMode: "century", quantity: 1, unitPrice: 30000,
    lineItems: [{ type: "game", description: "Century", quantity: 1, unitPrice: 30000, amount: 30000 }],
    subtotal: 30000, taxEnabled: false, taxRateBasisPoints: 0, taxAmount: 0, total: 30000, payerRule: "split",
    players: [{ name: "A", result: null, shareAmount: 15000, paidAmount: 0 }, { name: "B", result: null, shareAmount: 15000, paidAmount: 0 }],
    amountPaid: 0, status: "unpaid", createdAt, updatedAt: createdAt,
  });
  const AUG1 = { from: "2026-08-01", to: "2026-08-01" };

  // Exactly at the limit: allowed, complete
  await db().collection("bills").insertMany(Array.from({ length: 2000 }, (_, n) => rawBill(n)));
  const atLimit = await report("outstanding/print", AUG1);
  assert.equal(atLimit.bills.length, 2000);
  assert.equal(atLimit.totals.totalOutstanding, 2000 * 30000);

  // One more: refused with a clear message instead of a shortened list
  await db().collection("bills").insertOne(rawBill(2000));
  const over = await api("GET", `/reports/outstanding/print?${new URLSearchParams(AUG1)}`);
  assert.equal(over.status, 400);
  assert.equal(over.body.message, "There are too many outstanding bills to print at once (more than 2,000). Narrow the period or the filters, or use CSV export.");
  assert.equal(over.body.data, undefined, "no partial list is sent");

  // The CSV (limit 50,000) and the paged screen still work for the same 2,001 bills
  const csv = await api("GET", `/reports/export/outstanding?${new URLSearchParams(AUG1)}`);
  assert.equal(csv.status, 200);
  assert.equal(csv.text.trim().split("\r\n").length, 2002, "header + 2,001 rows");
  const paged = await report("outstanding", { ...AUG1, page: 81 });
  assert.deepEqual([paged.pagination.total, paged.pagination.pages, paged.bills.length], [2001, 81, 1]);
});

// ---------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------

test("CSV export: respects period and filters, is safely escaped, contains no secrets", async () => {
  await clearData();
  const t1 = await addTable("Main, Hall");
  const tricky = await billAt("2026-09-10T10:00:00", { players: [{ name: "=HYPERLINK(1)" }, { name: 'Sam "the" Cue', result: "loser" }] }, t1);
  await payAt(tricky, 10000, "2026-09-10T10:30:00", "cash", 'Sam "the" Cue');
  const b2 = await billAt("2026-09-10T11:00:00");
  await payAt(b2, 30000, "2026-09-10T11:30:00", "card");
  const outside = await billAt("2026-09-12T11:00:00");
  await payAt(outside, 30000, "2026-09-12T11:30:00", "cash");

  const csv = async (name, params) => {
    const response = await api("GET", `/reports/export/${name}?${new URLSearchParams(params)}`);
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers.get("content-type"), /^text\/csv; charset=utf-8/);
    assert.match(response.headers.get("content-disposition"), new RegExp(`^attachment; filename="${name}_`));
    assert.ok(!/passwordHash|scrypt|scp_session|tokenHash|AUTH_SECRET/i.test(response.text), "no secrets");
    return response.text.replace(/^﻿/, "").trim().split("\r\n");
  };

  const payments = await csv("payments", { ...SEP10, method: "cash" });
  assert.equal(payments.length, 2, "header + the one cash payment on 10 Sep (card and 12 Sep left out)");
  assert.match(payments[0], /^Received at,Bill,Bill date,Table,Game,Payer,Method,Amount \(Rs\),Received by$/);
  assert.match(payments[1], /^2026-09-10 10:30,B-/);
  assert.ok(payments[1].includes('"1 - Main, Hall"'), "comma in a value is quoted");
  assert.ok(payments[1].includes('"Sam ""the"" Cue"'), "quotes are doubled");
  assert.ok(payments[1].endsWith(",100.00,Test admin"));

  const outstanding = await csv("outstanding", SEP10);
  assert.equal(outstanding.length, 2, "only the unpaid... part-paid bill from 10 Sep");
  assert.ok(outstanding[1].includes(`"'=HYPERLINK(1), Sam ""the"" Cue"`), "formula-like text made harmless");

  const revenue = await csv("revenue", { from: "2026-09-10", to: "2026-09-11" });
  assert.deepEqual(revenue.slice(1), [
    "2026-09-10,2,0,600.00,400.00,200.00,400.00,2",
    "2026-09-11,0,0,0.00,0.00,0.00,0.00,0",
    "Total,2,0,600.00,400.00,200.00,400.00,2",
  ]);

  const tables = await csv("tables", { ...SEP10, tableId: t1.id });
  assert.equal(tables.length, 2, "table filter: one table");
  assert.equal((await csv("games", SEP10)).length, 2);

  const c = await customer("Csv Customer");
  await bookingAt(c.id, t1, "2026-09-10T15:00:00", "completed");
  await bookingAt(c.id, t1, "2026-09-10T16:00:00", "no_show");
  const bookings = await csv("bookings", { ...SEP10, bookingStatus: "no_show" });
  assert.equal(bookings.length, 2);
  assert.ok(bookings[1].startsWith("2026-09-10,16:00,17:00,"));
  assert.ok(!bookings.join("\n").includes("0300"), "phone numbers are not exported");
});

// ---------------------------------------------------------------------------
// Empty data and the dashboard
// ---------------------------------------------------------------------------

test("empty period: every report answers with hasData false and real zeros, never errors", async () => {
  await clearData();
  for (const name of REPORTS) {
    const data = await report(name, SEP10);
    assert.equal(data.hasData, false, name);
  }
  const revenue = await report("revenue", SEP10);
  assert.equal(revenue.summary.collectedPercent, null);
  assert.equal(revenue.summary.totalBilled, 0);
});

test("dashboard and reports agree on today's figures (one shared calculation)", async () => {
  await clearData();
  const bill = await billAt("2026-09-01T12:00:00");
  await db().collection("bills").updateOne({ _id: oid(bill.id) }, { $set: { createdAt: new Date() } });
  await api("POST", `/bills/${bill.id}/payments`, { body: { amount: 12345, method: "cash", payerName: "Usman" } });

  const dashboard = (await api("GET", "/dashboard/summary")).body.data.today;
  const { summary } = await report("revenue", { preset: "today" });
  assert.equal(dashboard.billCount, summary.billCount);
  assert.equal(dashboard.totalBilled, summary.totalBilled);
  assert.equal(dashboard.totalPaid, summary.totalPaid);
  assert.equal(dashboard.totalOutstanding, summary.totalOutstanding);
  assert.equal(dashboard.paymentsReceived, summary.paymentsReceived);
  assert.equal(dashboard.openCount, summary.openCount);
});

// ---------------------------------------------------------------------------
// Indexes: the report queries use indexes, not full collection scans
// ---------------------------------------------------------------------------

test("indexes: the main report queries are answered from indexes", async () => {
  const window = { $gte: karachi("2026-09-10T00:00:00"), $lt: karachi("2026-09-11T00:00:00") };
  const usesIndex = async (collection, filter) => {
    const plan = JSON.stringify(await db().collection(collection).find(filter).explain("queryPlanner"));
    assert.ok(plan.includes("IXSCAN"), `${collection} ${JSON.stringify(filter)} should use an index`);
    assert.ok(!plan.includes("COLLSCAN"), `${collection} must not scan the whole collection`);
  };
  await usesIndex("bills", { createdAt: window });
  await usesIndex("bills", { status: { $in: ["unpaid", "partially_paid"] }, createdAt: window });
  await usesIndex("payments", { paidAt: window });
  await usesIndex("sessions", { status: { $in: ["active", "completed"] }, startedAt: window });
  await usesIndex("sessions", { startedAt: { $lt: window.$lt }, $or: [{ status: "active" }, { status: "completed", endedAt: { $gt: window.$gte } }] });
  await usesIndex("bookings", { status: { $in: ["pending", "confirmed", "completed", "cancelled", "no_show"] }, startAt: window });
  await usesIndex("customers", { createdAt: window });
});
