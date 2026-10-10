// Automatic tests for /api/tables. Run with: npm test   (MongoDB must be running: npm run db)
// They use a SEPARATE database ("..._test") that is deleted afterwards,
// so your real club data is never touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user

const TEST_DB_URI = process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test";

let server;
let authCookie;
let baseUrl;

// Small helper: call the API and return { status, body }
async function api(method, path, body) {
  const options = { method, headers: { Cookie: authCookie } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api/tables${path}`, options);
  return { status: response.status, body: await response.json() };
}

const createTable = (data) => api("POST", "", data);

// Since Phase 4 "occupied" can't be set through the API (only by starting a session),
// so tests that need an occupied table set it directly in the test database.
const markOccupied = (tableNumber) =>
  mongoose.connection.collection("tables").updateOne({ tableNumber }, { $set: { status: "occupied" } });

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
  await mongoose.connection.collection("tables").deleteMany({});
  await mongoose.connection.collection("sessions").deleteMany({});
  await mongoose.connection.collection("bookings").deleteMany({});
});

// ---------- Create ----------

test("create: valid table -> 201 with clean JSON", async () => {
  const { status, body } = await createTable({ tableNumber: 3, name: "  VIP  ", hourlyRate: 60050 });
  assert.equal(status, 201);
  assert.equal(body.message, "Table 3 added");
  assert.match(body.data.id, /^[a-f0-9]{24}$/);
  assert.equal(body.data.name, "VIP"); // trimmed
  assert.equal(body.data.hourlyRate, 60050);
  assert.equal(body.data.status, "available"); // default
  assert.equal(body.data._id, undefined);
  assert.equal(body.data.__v, undefined);
});

test("create: number as text '7' is accepted and stored as a number", async () => {
  const { status, body } = await createTable({ tableNumber: "7", hourlyRate: "50000" });
  assert.equal(status, 201);
  assert.equal(body.data.tableNumber, 7);
  assert.equal(body.data.hourlyRate, 50000);
});

test("create: duplicate table number -> 409", async () => {
  await createTable({ tableNumber: 1, hourlyRate: 50000 });
  const { status, body } = await createTable({ tableNumber: 1, hourlyRate: 70000 });
  assert.equal(status, 409);
  assert.equal(body.message, "Table number 1 already exists");
  assert.deepEqual(body.errors, [{ field: "tableNumber", message: "Table number 1 already exists" }]);
});

test("create: validation errors -> 400 with one message per field", async () => {
  const cases = [
    [{}, { tableNumber: "Table number is required", hourlyRate: "Hourly rate is required" }],
    [{ tableNumber: 0, hourlyRate: 1 }, { tableNumber: "Table number must be a whole number from 1 to 999" }],
    [{ tableNumber: 1000, hourlyRate: 1 }, { tableNumber: "Table number must be a whole number from 1 to 999" }],
    [{ tableNumber: 2.5, hourlyRate: 1 }, { tableNumber: "Table number must be a whole number from 1 to 999" }],
    [{ tableNumber: "abc", hourlyRate: 1 }, { tableNumber: "Table number must be a whole number from 1 to 999" }],
    [{ tableNumber: true, hourlyRate: 1 }, { tableNumber: "Table number must be a whole number from 1 to 999" }],
    [{ tableNumber: 1, hourlyRate: -1 }, { hourlyRate: "Hourly rate must be between Rs 0 and Rs 100,000" }],
    [{ tableNumber: 1, hourlyRate: 600.5 }, { hourlyRate: "Hourly rate must be between Rs 0 and Rs 100,000" }],
    [{ tableNumber: 1, hourlyRate: 10_000_001 }, { hourlyRate: "Hourly rate must be between Rs 0 and Rs 100,000" }],
    [{ tableNumber: 1, hourlyRate: 1, name: "x".repeat(51) }, { name: "Name must be at most 50 characters" }],
    [{ tableNumber: 1, hourlyRate: 1, name: 42 }, { name: "Name must be text" }],
    [{ tableNumber: 1, hourlyRate: 1, status: "broken" }, { status: "Status must be one of: available, reserved, maintenance" }],
    [{ tableNumber: 1, hourlyRate: 1, status: "occupied" }, { status: "A table becomes occupied automatically when a session starts" }],
  ];
  for (const [input, expected] of cases) {
    const { status, body } = await createTable(input);
    assert.equal(status, 400, JSON.stringify(input));
    const actual = Object.fromEntries(body.errors.map((e) => [e.field, e.message]));
    assert.deepEqual(actual, expected, JSON.stringify(input));
  }
  const count = await mongoose.connection.collection("tables").countDocuments();
  assert.equal(count, 0, "nothing may be saved when validation fails");
});

test("create: hourly rate 0 (free table) is allowed; extra fields are ignored", async () => {
  const { status, body } = await createTable({ tableNumber: 9, hourlyRate: 0, isAdmin: true, _id: "x" });
  assert.equal(status, 201);
  assert.equal(body.data.hourlyRate, 0);
  assert.equal(body.data.isAdmin, undefined);
});

test("create: invalid JSON body -> 400", async () => {
  const { status, body } = await createTable("{ nope");
  assert.equal(status, 400);
  assert.equal(body.message, "Request body is not valid JSON");
});

// ---------- Read ----------

async function seedTables() {
  await createTable({ tableNumber: 3, name: "VIP Table", hourlyRate: 80000 });
  await createTable({ tableNumber: 1, name: "Corner", hourlyRate: 50000 });
  await markOccupied(1);
  await createTable({ tableNumber: 12, name: "Practice", hourlyRate: 40000, status: "maintenance" });
  await createTable({ tableNumber: 2, hourlyRate: 50000, status: "reserved" });
}

test("list: sorted by table number", async () => {
  await seedTables();
  const { status, body } = await api("GET", "");
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((t) => t.tableNumber), [1, 2, 3, 12]);
});

test("list: filter by status, search by name or number", async () => {
  await seedTables();
  const numbers = async (query) => (await api("GET", query)).body.data.map((t) => t.tableNumber);

  assert.deepEqual(await numbers("?status=occupied"), [1]);
  assert.deepEqual(await numbers("?status="), [1, 2, 3, 12]); // empty filter = all
  assert.deepEqual(await numbers("?search=vip"), [3]); // case-insensitive name
  assert.deepEqual(await numbers("?search=12"), [12]); // exact number
  assert.deepEqual(await numbers("?search=ac"), [12]); // part of "Practice"
  assert.deepEqual(await numbers("?search=.*"), []); // special characters are plain text
  assert.deepEqual(await numbers("?search=vip&status=available"), [3]);
  assert.deepEqual(await numbers("?search=vip&status=occupied"), []);

  const bad = await api("GET", "?status=sleeping");
  assert.equal(bad.status, 400);
});

test("summary: counts per status", async () => {
  await seedTables();
  const { status, body } = await api("GET", "/summary");
  assert.equal(status, 200);
  assert.deepEqual(body.data, { total: 4, available: 1, occupied: 1, reserved: 1, maintenance: 1 });
});

test("get one: found / not found / invalid id", async () => {
  const created = (await createTable({ tableNumber: 5, hourlyRate: 1000 })).body.data;
  assert.equal((await api("GET", `/${created.id}`)).body.data.tableNumber, 5);

  const missing = await api("GET", "/0123456789abcdef01234567");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, "Table not found");

  const invalid = await api("GET", "/not-an-id");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.message, "Invalid table id");
});

// ---------- Update ----------

test("update: partial change keeps other fields", async () => {
  const created = (await createTable({ tableNumber: 4, name: "Old", hourlyRate: 50000 })).body.data;
  const { status, body } = await api("PATCH", `/${created.id}`, { status: "maintenance", hourlyRate: 55000 });
  assert.equal(status, 200);
  assert.equal(body.message, "Table 4 updated");
  assert.equal(body.data.status, "maintenance");
  assert.equal(body.data.hourlyRate, 55000);
  assert.equal(body.data.name, "Old");
});

test("update: keeping its own number is fine; taking another table's number -> 409", async () => {
  const a = (await createTable({ tableNumber: 1, hourlyRate: 1 })).body.data;
  await createTable({ tableNumber: 2, hourlyRate: 1 });

  assert.equal((await api("PATCH", `/${a.id}`, { tableNumber: 1, name: "Same" })).status, 200);
  const clash = await api("PATCH", `/${a.id}`, { tableNumber: 2 });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.message, "Table number 2 already exists");
});

test("update: empty body, bad values, missing table", async () => {
  const a = (await createTable({ tableNumber: 1, hourlyRate: 1 })).body.data;

  const empty = await api("PATCH", `/${a.id}`, {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.message, /Send at least one field to update/);

  assert.equal((await api("PATCH", `/${a.id}`, { hourlyRate: -5 })).status, 400);
  assert.equal((await api("PATCH", `/${a.id}`, { status: "closed" })).status, 400);
  assert.equal((await api("PATCH", "/0123456789abcdef01234567", { name: "x" })).status, 404);

  const unchanged = (await api("GET", `/${a.id}`)).body.data;
  assert.equal(unchanged.hourlyRate, 1);
});

// ---------- Delete ----------

test("delete: free table -> 200, then 404", async () => {
  const a = (await createTable({ tableNumber: 8, hourlyRate: 1 })).body.data;
  const { status, body } = await api("DELETE", `/${a.id}`);
  assert.equal(status, 200);
  assert.equal(body.message, "Table 8 deleted");
  assert.equal((await api("DELETE", `/${a.id}`)).status, 404);
});

test("delete: blocked while occupied", async () => {
  const a = (await createTable({ tableNumber: 8, hourlyRate: 1 })).body.data;
  await markOccupied(8);
  const { status, body } = await api("DELETE", `/${a.id}`);
  assert.equal(status, 409);
  assert.equal(body.message, "Table 8 is currently occupied. Free the table before deleting it.");
});

test("delete: blocked by an open session, allowed after it closes", async () => {
  const a = (await createTable({ tableNumber: 6, hourlyRate: 1 })).body.data;
  const sessions = mongoose.connection.collection("sessions");
  const tableId = new mongoose.Types.ObjectId(a.id);

  await sessions.insertOne({ table: tableId, isOpen: true });
  const blocked = await api("DELETE", `/${a.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.message, "Table 6 has an active session. Stop the session before deleting the table.");

  await sessions.updateMany({ table: tableId }, { $set: { isOpen: false } });
  assert.equal((await api("DELETE", `/${a.id}`)).status, 200);
});

test("delete: blocked by an upcoming booking, not by past or cancelled ones", async () => {
  const a = (await createTable({ tableNumber: 7, hourlyRate: 1 })).body.data;
  const bookings = mongoose.connection.collection("bookings");
  const tableId = new mongoose.Types.ObjectId(a.id);
  const hour = 60 * 60 * 1000;

  await bookings.insertMany([
    { table: tableId, status: "confirmed", endAt: new Date(Date.now() - hour) }, // already over
    { table: tableId, status: "cancelled", endAt: new Date(Date.now() + hour) }, // cancelled
  ]);
  // Past and cancelled bookings don't block... (checked by adding an upcoming one next)
  await bookings.insertOne({ table: tableId, status: "pending", endAt: new Date(Date.now() + hour) });

  const blocked = await api("DELETE", `/${a.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.message, "Table 7 has 1 upcoming booking(s). Cancel or move them before deleting the table.");

  await bookings.deleteMany({ status: "pending" });
  assert.equal((await api("DELETE", `/${a.id}`)).status, 200);
});
