// Automatic tests for /api/customers (Phase 7).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user
const { dateInTimeZone } = require("../utils/time");

const TEST_DB_URI = process.env.MONGODB_CUSTOMERS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_customers";
const TOMORROW = dateInTimeZone(new Date(Date.now() + 24 * 3600 * 1000), "Asia/Karachi");

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

const addCustomer = async (data) => (await api("POST", "/customers", data)).body.data;

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
  for (const name of ["customers", "bookings", "tables"]) await mongoose.connection.collection(name).deleteMany({});
});

test("create: phone optional, trimmed, digits kept for search", async () => {
  const withPhone = await api("POST", "/customers", { name: "  Ali Raza ", phone: " 0300-1234567 ", notes: "Regular" });
  assert.equal(withPhone.status, 201);
  assert.equal(withPhone.body.message, "Customer Ali Raza added");
  assert.equal(withPhone.body.data.name, "Ali Raza");
  assert.equal(withPhone.body.data.phone, "0300-1234567");
  assert.equal(withPhone.body.data.phoneDigits, "03001234567");
  assert.equal(withPhone.body.data.isActive, true);

  const noPhone = await api("POST", "/customers", { name: "Usman" });
  assert.equal(noPhone.status, 201);
  assert.equal(noPhone.body.data.phone, "");

  const international = await api("POST", "/customers", { name: "Bilal", phone: "+92 300 1234567" });
  assert.equal(international.status, 201);

  const samePhone = await api("POST", "/customers", { name: "Ali's brother", phone: "0300-1234567" });
  assert.equal(samePhone.status, 201, "phone numbers don't have to be unique");
});

test("create: validation", async () => {
  const cases = [
    [{}, "Customer name is required"],
    [{ name: "A" }, "Name must be 2 to 60 characters"],
    [{ name: "x".repeat(61) }, "Name must be 2 to 60 characters"],
    [{ name: "Ali", phone: "abc" }, "Phone must be 7 to 20 digits (spaces, - and a leading + are allowed)"],
    [{ name: "Ali", phone: "123" }, "Phone must be 7 to 20 digits (spaces, - and a leading + are allowed)"],
    [{ name: "Ali", notes: "n".repeat(201) }, "Notes must be at most 200 characters"],
  ];
  for (const [input, message] of cases) {
    const { status, body } = await api("POST", "/customers", input);
    assert.equal(status, 400, JSON.stringify(input));
    assert.equal(body.message, message, JSON.stringify(input));
  }
});

test("list: search by name or phone digits, sorted by name, with booking counts", async () => {
  await addCustomer({ name: "Zubair", phone: "0333 7654321" });
  await addCustomer({ name: "Ali Raza", phone: "0300-1234567" });
  await addCustomer({ name: "Kamran" });

  const names = async (q) => (await api("GET", `/customers${q}`)).body.data.customers.map((c) => c.name);
  assert.deepEqual(await names(""), ["Ali Raza", "Kamran", "Zubair"]);
  assert.deepEqual(await names("?search=ali"), ["Ali Raza"]);
  assert.deepEqual(await names("?search=0300 123"), ["Ali Raza"]); // spaces/dashes don't matter
  assert.deepEqual(await names("?search=7654"), ["Zubair"]);
  const first = (await api("GET", "/customers")).body.data.customers[0];
  assert.equal(first.bookingCount, 0);
  assert.equal(first.lastBookingAt, null);
});

test("update and delete: no bookings -> deleted; with bookings -> archived and hidden", async () => {
  const plain = await addCustomer({ name: "Walk In" });
  const updated = await api("PATCH", `/customers/${plain.id}`, { phone: "0321-5550000" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.phoneDigits, "03215550000");
  assert.equal((await api("PATCH", `/customers/${plain.id}`, {})).status, 400);

  const removed = await api("DELETE", `/customers/${plain.id}`);
  assert.equal(removed.body.data.result, "deleted");
  assert.equal((await api("GET", `/customers/${plain.id}`)).status, 404);

  const regular = await addCustomer({ name: "Regular Player", phone: "0300-1111111" });
  const table = (await api("POST", "/tables", { tableNumber: 1, hourlyRate: 1 })).body.data;
  const booking = await api("POST", "/bookings", { customerId: regular.id, tableId: table.id, date: TOMORROW, startTime: "18:00", durationMinutes: 60 });
  assert.equal(booking.status, 201);

  const archived = await api("DELETE", `/customers/${regular.id}`);
  assert.equal(archived.body.data.result, "archived");
  assert.equal(archived.body.message, "Customer Regular Player archived (kept because they have bookings)");
  assert.deepEqual((await api("GET", "/customers")).body.data.customers.map((c) => c.name), []);
  assert.deepEqual((await api("GET", "/customers?includeArchived=true")).body.data.customers.map((c) => c.name), ["Regular Player"]);

  const blocked = await api("POST", "/bookings", { customerId: regular.id, tableId: table.id, date: TOMORROW, startTime: "20:00", durationMinutes: 60 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.message, "Regular Player is archived");
});

test("profile: booking history and counts", async () => {
  const customer = await addCustomer({ name: "History Test" });
  const table = (await api("POST", "/tables", { tableNumber: 2, hourlyRate: 1 })).body.data;
  const book = (startTime) => api("POST", "/bookings", { customerId: customer.id, tableId: table.id, date: TOMORROW, startTime, durationMinutes: 60 });
  const a = (await book("14:00")).body.data;
  await book("16:00");
  await api("POST", `/bookings/${a.id}/cancel`, { reason: "Changed plans" });

  const { status, body } = await api("GET", `/customers/${customer.id}`);
  assert.equal(status, 200);
  assert.deepEqual(body.data.stats, { bookings: 2, completed: 0, upcoming: 1, noShows: 0, cancelled: 1 });
  assert.deepEqual(body.data.bookings.map((b) => b.status), ["pending", "cancelled"]); // newest first
  const listed = (await api("GET", "/customers?search=history")).body.data.customers[0];
  assert.equal(listed.bookingCount, 2);
});
