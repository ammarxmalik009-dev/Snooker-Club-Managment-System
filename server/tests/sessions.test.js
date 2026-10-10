// Automatic tests for /api/sessions and how sessions change tables.
// Run with: npm test   (MongoDB must be running: npm run db)
// Uses its own throw-away database, deleted afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user

const TEST_DB_URI = process.env.MONGODB_SESSIONS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_sessions";

let server;
let authCookie;
let baseUrl;

async function api(method, path, body) {
  const options = { method, headers: { Cookie: authCookie } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json() };
}

const sessionsDb = () => mongoose.connection.collection("sessions");
const tablesDb = () => mongoose.connection.collection("tables");

async function addTable(tableNumber, extra = {}) {
  const { status, body } = await api("POST", "/tables", { tableNumber, hourlyRate: 60000, ...extra });
  assert.equal(status, 201, JSON.stringify(body));
  return body.data;
}

const start = (tableId) => api("POST", "/sessions", { tableId });
const end = (sessionId) => api("POST", `/sessions/${sessionId}/end`);
const getTable = async (id) => (await api("GET", `/tables/${id}`)).body.data;

// Move a session's start time into the past (so we can test durations without waiting)
const setStartedAt = (sessionId, date) =>
  sessionsDb().updateOne({ _id: new mongoose.Types.ObjectId(sessionId) }, { $set: { startedAt: date } });

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

test.beforeEach(async () => {
  await tablesDb().deleteMany({});
  await sessionsDb().deleteMany({});
});

// ---------- Start ----------

test("start on an available table -> 201, server time recorded, table becomes occupied", async () => {
  const table = await addTable(3, { name: "VIP" });
  const before = Date.now();
  const { status, body } = await start(table.id);

  assert.equal(status, 201);
  assert.equal(body.message, "Session started on Table 3");
  const session = body.data;
  assert.equal(session.table, table.id);
  assert.equal(session.tableNumber, 3);
  assert.equal(session.tableName, "VIP");
  assert.equal(session.hourlyRateAtStart, 60000);
  assert.equal(session.status, "active");
  assert.equal(session.isOpen, true);
  assert.equal(session.endedAt, null);
  assert.equal(session.durationSeconds, null);
  const startedAt = Date.parse(session.startedAt);
  assert.ok(startedAt >= before - 1000 && startedAt <= Date.now() + 1000, "startedAt should be 'now' on the server");
  // No billing yet (Phase 5)
  for (const field of ["amount", "total", "bill", "billableMinutes"]) assert.equal(session[field], undefined);

  assert.equal((await getTable(table.id)).status, "occupied");
});

test("start is refused on occupied, reserved and maintenance tables", async () => {
  const busy = await addTable(1);
  const reserved = await addTable(2, { status: "reserved" });
  const repair = await addTable(4, { status: "maintenance" });
  await start(busy.id);

  const cases = [
    [busy, "Table 1 is already occupied. A session can only start on an available table."],
    [reserved, "Table 2 is reserved. A session can only start on an available table."],
    [repair, "Table 4 is under maintenance. A session can only start on an available table."],
  ];
  for (const [table, message] of cases) {
    const { status, body } = await start(table.id);
    assert.equal(status, 409);
    assert.equal(body.message, message);
  }
  assert.equal(await sessionsDb().countDocuments(), 1, "only the first session exists");
  assert.equal((await getTable(reserved.id)).status, "reserved", "a refused start must not change the table");
});

test("start: missing / invalid table id", async () => {
  assert.equal((await start("0123456789abcdef01234567")).status, 404);
  const invalid = await start("nope");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.message, "Invalid table id");
  const missing = await api("POST", "/sessions", {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.message, "Choose a table to start the session on");
});

test("10 staff press Start at the same moment -> exactly one session", async () => {
  const table = await addTable(5);
  const results = await Promise.all(Array.from({ length: 10 }, () => start(table.id)));

  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
  assert.equal(await sessionsDb().countDocuments({ isOpen: true }), 1);
});

test("the database itself refuses a second open session on a table", async () => {
  const table = await addTable(6);
  await start(table.id);
  await assert.rejects(
    sessionsDb().insertOne({ table: new mongoose.Types.ObjectId(table.id), isOpen: true, tableNumber: 6 }),
    (error) => error.code === 11000
  );
});

// ---------- End ----------

test("end -> duration calculated on the server, table available again", async () => {
  const table = await addTable(7);
  const session = (await start(table.id)).body.data;
  await setStartedAt(session.id, new Date(Date.now() - (65 * 60 + 3) * 1000)); // 1h 05m 03s ago

  const { status, body } = await end(session.id);
  assert.equal(status, 200);
  assert.equal(body.message, "Session on Table 7 ended");
  assert.equal(body.data.status, "completed");
  assert.equal(body.data.isOpen, false);
  assert.ok(body.data.durationSeconds >= 3903 && body.data.durationSeconds <= 3905, `duration ${body.data.durationSeconds}`);
  assert.ok(Date.parse(body.data.endedAt) >= Date.parse(body.data.startedAt));

  assert.equal((await getTable(table.id)).status, "available");
});

test("end twice / two people at once -> only one succeeds", async () => {
  const table = await addTable(8);
  const session = (await start(table.id)).body.data;

  const [a, b] = await Promise.all([end(session.id), end(session.id)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  const again = await end(session.id);
  assert.equal(again.status, 409);
  assert.equal(again.body.message, "This session on Table 8 has already ended");
});

test("end: missing / invalid session id", async () => {
  const missing = await end("0123456789abcdef01234567");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, "Session not found");
  assert.equal((await end("xyz")).status, 400);
});

test("a table can be played again after its session ended", async () => {
  const table = await addTable(9);
  const first = (await start(table.id)).body.data;
  await end(first.id);
  const second = await start(table.id);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.data.id, first.id);
});

// ---------- Lists ----------

test("active list: only running sessions, oldest first, with server time", async () => {
  const t1 = await addTable(1);
  const t2 = await addTable(2);
  const t3 = await addTable(3);
  const s1 = (await start(t1.id)).body.data;
  const s2 = (await start(t2.id)).body.data;
  const s3 = (await start(t3.id)).body.data;
  await setStartedAt(s2.id, new Date(Date.now() - 3600 * 1000)); // s2 is the oldest
  await end(s3.id);

  const { status, body } = await api("GET", "/sessions/active");
  assert.equal(status, 200);
  assert.deepEqual(body.data.sessions.map((s) => s.id), [s2.id, s1.id]);
  assert.ok(Math.abs(Date.parse(body.data.serverTime) - Date.now()) < 5000);
});

test("history: Karachi day filter, status, search and paging", async () => {
  const table = await addTable(11, { name: "Corner" });
  const other = await addTable(12, { name: "VIP Lounge" });
  const ids = [];
  // Make finished sessions at chosen UTC times (Karachi = UTC+5).
  // Dates are in the past on purpose, so the still-running session ("today") never matches.
  const times = [
    ["2026-09-14T18:59:00Z", table], // 14 Sep 23:59 Karachi
    ["2026-09-14T19:00:00Z", table], // 15 Sep 00:00 Karachi
    ["2026-09-15T18:59:59Z", other], // 15 Sep 23:59:59 Karachi
    ["2026-09-15T19:00:00Z", other], // 16 Sep 00:00 Karachi
  ];
  for (const [time, t] of times) {
    const s = (await start(t.id)).body.data;
    await setStartedAt(s.id, new Date(time));
    await end(s.id);
    ids.push(s.id);
  }
  const running = (await start(table.id)).body.data; // one still active

  const query = async (q) => (await api("GET", `/sessions${q}`)).body.data;

  const sep15 = await query("?from=2026-09-15&to=2026-09-15");
  assert.deepEqual(sep15.sessions.map((s) => s.id), [ids[2], ids[1]], "only sessions that started on 15 Sep Karachi time, newest first");
  const range = await query("?from=2026-09-14&to=2026-09-15");
  assert.equal(range.total, 3, "14-15 Sep includes the 23:59 session but not the 16 Sep one");

  const completed = await query("?status=completed");
  assert.equal(completed.total, 4);
  assert.ok(completed.sessions.every((s) => s.status === "completed" && s.durationSeconds !== null));

  assert.equal((await query("?status=active")).sessions[0].id, running.id);
  assert.deepEqual((await query("?search=vip")).sessions.map((s) => s.tableNumber), [12, 12]);
  assert.equal((await query("?search=11&status=completed")).total, 2);

  const page1 = await query("?limit=2&page=1");
  const page3 = await query("?limit=2&page=3");
  assert.equal(page1.total, 5);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.sessions.length, 2);
  assert.equal(page3.sessions.length, 1);

  const backwards = await api("GET", "/sessions?from=2026-10-05&to=2026-10-01");
  assert.equal(backwards.status, 400);
  assert.equal(backwards.body.message, "To date cannot be before the From date");
  assert.equal((await api("GET", "/sessions?from=2026-13-01")).status, 400);
  assert.equal((await api("GET", "/sessions?status=paused")).status, 400);
});

// ---------- Sessions and tables together ----------

test("while a session runs: status locked, other details editable, delete blocked", async () => {
  const table = await addTable(15, { name: "Old name" });
  const session = (await start(table.id)).body.data;

  const lock = await api("PATCH", `/tables/${table.id}`, { status: "maintenance" });
  assert.equal(lock.status, 409);
  assert.equal(lock.body.message, "Table 15 has an active session. End the session to change its status.");

  const rename = await api("PATCH", `/tables/${table.id}`, { name: "New name", hourlyRate: 99000 });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.data.status, "occupied");

  const del = await api("DELETE", `/tables/${table.id}`);
  assert.equal(del.status, 409);

  // The running session keeps the details from when it started
  const stored = (await api("GET", `/sessions/${session.id}`)).body.data;
  assert.equal(stored.tableName, "Old name");
  assert.equal(stored.hourlyRateAtStart, 60000);

  await end(session.id);
  assert.equal((await api("PATCH", `/tables/${table.id}`, { status: "maintenance" })).status, 200);
});

test("an 'occupied' table without a running session can be freed by hand (recovery)", async () => {
  const table = await addTable(16);
  await tablesDb().updateOne({ tableNumber: 16 }, { $set: { status: "occupied" } });
  const fix = await api("PATCH", `/tables/${table.id}`, { status: "available" });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.data.status, "available");
});
