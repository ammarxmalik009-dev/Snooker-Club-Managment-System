// Automatic tests for GET /api/dashboard/summary (Phase 6).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user

const TEST_DB_URI = process.env.MONGODB_DASHBOARD_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_dashboard";
const DAY = "2026-09-10"; // a fixed business day, so the test never depends on "now"
// Karachi is UTC+5: 10 Sep 00:00 Karachi = 9 Sep 19:00 UTC
const karachi = (iso) => new Date(new Date(`${iso}+05:00`).getTime());

let server;
let authCookie;
let baseUrl;
let tableNumber = 0;

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
const oid = (id) => new mongoose.Types.ObjectId(id);
const summary = async (date = DAY) => (await api("GET", `/dashboard/summary${date ? `?date=${date}` : ""}`)).body.data;

async function addTable(extra = {}) {
  tableNumber += 1;
  return (await api("POST", "/tables", { tableNumber, hourlyRate: 1, name: `T${tableNumber}`, ...extra })).body.data;
}

async function finishedSession(seconds = 20 * 60) {
  const table = await addTable();
  const session = (await api("POST", "/sessions", { tableId: table.id })).body.data;
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - seconds * 1000) } });
  return (await api("POST", `/sessions/${session.id}/end`)).body.data;
}

// A bill for a new session, then moved to the given creation time
async function billAt(createdAt, extra = {}) {
  const session = await finishedSession();
  const { body } = await api("POST", "/bills", {
    sessionId: session.id, gameMode: "century", quantity: 1, payerRule: "loser",
    players: [{ name: "Ali" }, { name: "Usman", result: "loser" }], ...extra,
  });
  await db().collection("bills").updateOne({ _id: oid(body.data.id) }, { $set: { createdAt } });
  return body.data;
}

async function payAt(bill, amount, paidAt) {
  const { body } = await api("POST", `/bills/${bill.id}/payments`, { amount, method: "cash", payerName: "Usman" });
  await db().collection("payments").updateOne({ _id: oid(body.data.payment.id) }, { $set: { paidAt } });
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

test("empty club: zeros and empty lists (not errors)", async () => {
  const data = await summary();
  assert.deepEqual(data.businessDay, { date: DAY, timeZone: "Asia/Karachi", start: "2026-09-09T19:00:00.000Z", end: "2026-09-10T19:00:00.000Z" });
  assert.deepEqual(data.tables, { total: 0, available: 0, occupied: 0, reserved: 0, maintenance: 0 });
  assert.equal(data.activeSessionCount, 0);
  assert.deepEqual(data.today, { billCount: 0, paidCount: 0, openCount: 0, cancelledCount: 0, totalBilled: 0, totalPaid: 0,
                                 totalOutstanding: 0, paymentsReceived: 0, paymentCount: 0, bookingCount: 0 });
  assert.deepEqual([data.activeSessions, data.tableOverview, data.recentBills, data.recentSessions, data.upcomingBookings],
                   [[], [], [], [], []]);
  assert.ok(Math.abs(Date.parse(data.serverTime) - Date.now()) < 5000);
});

test("default day is today in Karachi; bad dates are refused", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  assert.equal((await summary(null)).businessDay.date, today);
  assert.equal((await api("GET", "/dashboard/summary?date=2026-13-01")).status, 400);
});

test("today's money: Karachi day boundaries, cancelled bills excluded, payments for older bills counted as received", async () => {
  // Phase 11.3: Century is per billed minute: 20 min sessions × Rs 15 = Rs 300 per century bill.
  // (2 games used to cost twice as much; now the time decides, so "atMidnight" is 30000, not 60000.)
  await api("PATCH", "/settings", { gameRates: { century: 1500 }, framePrice: 15000 });

  const atMidnight = await billAt(karachi(`${DAY}T00:00:00`), { quantity: 2 });      // 30000 - first second of the day
  const morning = await billAt(karachi(`${DAY}T10:00:00`));                            // 30000
  const lastSecond = await billAt(karachi(`${DAY}T23:59:59`), { gameMode: "frame" });  // 15000 - last second of the day
  const cancelled = await billAt(karachi(`${DAY}T12:00:00`));                          // 30000, cancelled
  const yesterday = await billAt(karachi("2026-09-09T23:59:59"));                      // 30000, day before
  await billAt(karachi("2026-09-11T00:00:00"));                                         // 30000, day after

  await api("POST", `/bills/${cancelled.id}/cancel`);
  await payAt(morning, 30000, karachi(`${DAY}T11:00:00`));     // fully paid
  await payAt(atMidnight, 20000, karachi(`${DAY}T01:00:00`));  // partly paid
  await payAt(yesterday, 10000, karachi(`${DAY}T09:00:00`));   // old bill, paid today
  await payAt(lastSecond, 5000, karachi("2026-09-11T00:30:00")); // paid the NEXT day

  const { today } = await summary();
  assert.deepEqual(today, {
    billCount: 3,            // midnight, morning, last second (not cancelled, not other days)
    paidCount: 1,            // morning
    openCount: 2,            // midnight (partly paid) + last second (unpaid on that day's bill)
    cancelledCount: 1,
    totalBilled: 75000,      // 30000 + 30000 + 15000 - the cancelled 30000 is NOT revenue
    totalPaid: 55000,        // amounts paid on those 3 bills so far: 20000 + 30000 + 5000
    totalOutstanding: 20000, // 75000 - 55000
    paymentsReceived: 60000, // money that came in on 10 Sep: 30000 + 20000 + 10000 (old bill)
    paymentCount: 3,
    bookingCount: 0,         // (bookings are tested in bookings.test.js)
  });

  // The day before and after are separate days
  assert.equal((await summary("2026-09-09")).today.totalBilled, 30000);
  assert.equal((await summary("2026-09-11")).today.paymentsReceived, 5000);

  // Changing the rate list never changes historical numbers
  await api("PATCH", "/settings", { gameRates: { century: 99900 } });
  assert.equal((await summary()).today.totalBilled, 75000);
  await api("PATCH", "/settings", { gameRates: { century: 1500 } });
});

test("tables, active sessions and the table overview", async () => {
  await db().collection("tables").deleteMany({});
  await db().collection("sessions").deleteMany({ isOpen: true });
  const free = await addTable({ name: "Free" });
  const busy = await addTable({ name: "Busy" });
  await addTable({ status: "reserved" });
  await addTable({ status: "maintenance" });
  const session = (await api("POST", "/sessions", { tableId: busy.id })).body.data;

  const data = await summary();
  assert.deepEqual(data.tables, { total: 4, available: 1, occupied: 1, reserved: 1, maintenance: 1 });
  assert.equal(data.activeSessionCount, 1);
  assert.equal(data.activeSessions[0].id, session.id);
  assert.equal(data.activeSessions[0].tableName, "Busy");

  const overview = new Map(data.tableOverview.map((t) => [t.id, t]));
  assert.equal(data.tableOverview.length, 4);
  assert.deepEqual(overview.get(busy.id).activeSession, { id: session.id, startedAt: session.startedAt });
  assert.equal(overview.get(busy.id).status, "occupied");
  assert.equal(overview.get(free.id).activeSession, null);
  assert.deepEqual(data.tableOverview.map((t) => t.tableNumber), [...data.tableOverview.map((t) => t.tableNumber)].sort((a, b) => a - b));

  await api("POST", `/sessions/${session.id}/end`);
  const after = await summary();
  assert.equal(after.activeSessionCount, 0);
  assert.equal(after.tables.available, 2);
});

test("recent bills and recent sessions: newest first, with bill details", async () => {
  const unbilled = await finishedSession(5 * 60);
  const billed = await billAt(new Date(), { gameMode: "frame", quantity: 3, payerRule: "split",
                                            players: [{ name: "Kamran" }, { name: "Zubair" }, { name: "Imran" }] });

  const data = await summary(null);
  assert.ok(data.recentBills.length <= 6);
  const newestBill = data.recentBills[0];
  assert.equal(newestBill.id, billed.id);
  assert.deepEqual(newestBill.players, ["Kamran", "Zubair", "Imran"]);
  assert.equal(newestBill.total, 45000);
  assert.equal(newestBill.balanceDue, 45000);
  assert.equal(newestBill.status, "unpaid");
  assert.ok(data.recentBills.every((b, i, list) => i === 0 || Date.parse(list[i - 1].createdAt) >= Date.parse(b.createdAt)));
  const cancelledRow = data.recentBills.find((b) => b.status === "cancelled");
  if (cancelledRow) assert.equal(cancelledRow.balanceDue, 0);

  assert.ok(data.recentSessions.length <= 6);
  assert.ok(data.recentSessions.every((s) => s.status === "completed"));
  assert.ok(data.recentSessions.every((s, i, list) => i === 0 || Date.parse(list[i - 1].endedAt) >= Date.parse(s.endedAt)));
  const withBill = data.recentSessions.find((s) => s.id === billed.session);
  assert.deepEqual(withBill.bill, { id: billed.id, billNumber: billed.billNumber, status: "unpaid", total: 45000, amountPaid: 0,
                                    gameMode: "frame", quantity: 3, billedMinutes: 20 });
  const withoutBill = data.recentSessions.find((s) => s.id === unbilled.id);
  assert.equal(withoutBill.bill, null);
});
