// Automatic tests for /api/bookings (Phase 7).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth"); // Phase 8: tests log in like a real user
const { dateInTimeZone } = require("../utils/time");

const TEST_DB_URI = process.env.MONGODB_BOOKINGS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_bookings";
const DAY_MS = 24 * 3600 * 1000;
const clubDate = (offsetDays) => dateInTimeZone(new Date(Date.now() + offsetDays * DAY_MS), "Asia/Karachi");
const TOMORROW = clubDate(1);
const YESTERDAY = clubDate(-1);
const MINUTE = 60 * 1000;

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

async function addTable(extra = {}) {
  tableNumber += 1;
  return (await api("POST", "/tables", { tableNumber, hourlyRate: 60000, name: `T${tableNumber}`, ...extra })).body.data;
}
async function addCustomer(name = "Ali Raza", phone = "0300-1234567") {
  return (await api("POST", "/customers", { name, phone })).body.data;
}
const book = (tableId, customerId, startTime, durationMinutes = 60, date = TOMORROW, extra = {}) =>
  api("POST", "/bookings", { tableId, customerId, date, startTime, durationMinutes, ...extra });

// Move a booking so it starts `minutesFromNow` minutes from now (negative = already started)
async function moveStart(bookingId, minutesFromNow, durationMinutes = 90) {
  const startAt = new Date(Date.now() + minutesFromNow * MINUTE);
  await db().collection("bookings").updateOne({ _id: oid(bookingId) },
    { $set: { startAt, endAt: new Date(startAt.getTime() + durationMinutes * MINUTE) } });
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

// ---------- Create ----------

test("create: existing customer, club-local time stored as UTC, copies kept", async () => {
  const table = await addTable({ name: "VIP" });
  const customer = await addCustomer();
  const { status, body } = await book(table.id, customer.id, "18:30", 90, TOMORROW, { notes: "Birthday" });

  assert.equal(status, 201);
  assert.equal(body.message, `Table ${table.tableNumber} booked for Ali Raza`);
  const b = body.data;
  assert.equal(b.startAt, new Date(`${TOMORROW}T18:30:00+05:00`).toISOString()); // 13:30 UTC
  assert.equal(b.endAt, new Date(`${TOMORROW}T20:00:00+05:00`).toISOString());
  assert.equal(b.status, "pending");
  assert.deepEqual([b.customerName, b.customerPhone, b.tableNumber, b.tableName, b.notes],
                   ["Ali Raza", "0300-1234567", table.tableNumber, "VIP", "Birthday"]);
});

test("create: a new customer can be added with the booking (phone optional)", async () => {
  const table = await addTable();
  const { status, body } = await api("POST", "/bookings", {
    tableId: table.id, newCustomer: { name: "  New Guy ", phone: "" }, date: TOMORROW, startTime: "12:00", durationMinutes: 30, status: "confirmed",
  });
  assert.equal(status, 201);
  assert.equal(body.data.customerName, "New Guy");
  assert.equal(body.data.status, "confirmed");
  const customer = (await api("GET", `/customers/${body.data.customer}`)).body.data;
  assert.equal(customer.name, "New Guy");
});

test("create: validation and time rules", async () => {
  const table = await addTable();
  const customer = await addCustomer("Validator");
  const base = { tableId: table.id, customerId: customer.id, date: TOMORROW, startTime: "18:00", durationMinutes: 60 };
  const cases = [
    [{ startTime: "18:10" }, 400, "Start time must be like 18:30 (every 15 minutes)"],
    [{ startTime: "25:00" }, 400, "Start time must be like 18:30 (every 15 minutes)"],
    [{ durationMinutes: 20 }, 400, "Duration must be from 30 minutes to 8 hours"],
    [{ durationMinutes: 500 }, 400, "Duration must be from 30 minutes to 8 hours"],
    [{ durationMinutes: 50 }, 400, "Duration must be in 15-minute steps"],
    [{ date: "2026-02-30" }, 400, "Date must be a date like 2026-10-07"],
    [{ date: YESTERDAY }, 400, "The start time is in the past"],
    [{ date: clubDate(70) }, 400, "Bookings can be made up to 60 days ahead"],
    [{ customerId: undefined }, 400, "Choose a customer or add a new one"],
    [{ customerId: undefined, newCustomer: { name: "X" } }, 400, "Customer name must be 2 to 60 characters"],
    [{ tableId: "0123456789abcdef01234567" }, 404, "Table not found"],
    [{ customerId: "0123456789abcdef01234567" }, 404, "Customer not found"],
  ];
  for (const [change, status, message] of cases) {
    const { status: actual, body } = await api("POST", "/bookings", { ...base, ...change });
    assert.equal(actual, status, JSON.stringify(change));
    assert.ok(body.message === message || (body.errors || []).some((e) => e.message === message), `${JSON.stringify(change)} -> ${body.message}`);
  }
});

// ---------- Double bookings ----------

test("overlaps are refused; touching slots and other tables are fine; cancelled bookings free the slot", async () => {
  const table = await addTable();
  const other = await addTable();
  const ali = await addCustomer("Ali");
  const usman = await addCustomer("Usman");

  const first = await book(table.id, ali.id, "18:00", 90); // 18:00 - 19:30
  assert.equal(first.status, 201);

  const clash = await book(table.id, usman.id, "19:00", 120);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.message, `Table ${table.tableNumber} is already booked 6:00 pm–7:30 pm (Ali)`);
  assert.equal((await book(table.id, usman.id, "17:30", 60)).status, 409); // 17:30-18:30 overlaps
  assert.equal((await book(table.id, usman.id, "18:15", 30)).status, 409); // inside

  assert.equal((await book(table.id, usman.id, "19:30", 60)).status, 201); // starts when the first ends
  assert.equal((await book(table.id, usman.id, "17:00", 60)).status, 201); // ends when the first starts
  assert.equal((await book(other.id, usman.id, "18:00", 90)).status, 201); // another table

  await api("POST", `/bookings/${first.body.data.id}/cancel`, { reason: "Called to cancel" });
  assert.equal((await book(table.id, usman.id, "18:00", 90)).status, 201, "cancelled booking no longer blocks the slot");
});

test("10 people book the same slot at the same moment -> exactly one booking", async () => {
  const table = await addTable();
  const customersBefore = await db().collection("customers").countDocuments();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    api("POST", "/bookings", { tableId: table.id, newCustomer: { name: `Racer ${i}` }, date: TOMORROW, startTime: "21:00", durationMinutes: 60 })));

  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
  assert.equal(await db().collection("bookings").countDocuments({ table: oid(table.id) }), 1);
  assert.equal(await db().collection("customers").countDocuments(), customersBefore + 1, "failed bookings don't leave customers behind");
});

test("edit: reschedule and change table with the same overlap rule (ignoring itself)", async () => {
  const table = await addTable();
  const other = await addTable();
  const ali = await addCustomer("Edit Ali");
  const a = (await book(table.id, ali.id, "10:00", 60)).body.data;
  await book(table.id, ali.id, "12:00", 60);

  const longer = await api("PATCH", `/bookings/${a.id}`, { date: TOMORROW, startTime: "10:00", durationMinutes: 120 });
  assert.equal(longer.status, 200, "extending into its own old time is fine");
  const clash = await api("PATCH", `/bookings/${a.id}`, { date: TOMORROW, startTime: "11:00", durationMinutes: 90 });
  assert.equal(clash.status, 409);
  const moved = await api("PATCH", `/bookings/${a.id}`, { tableId: other.id, notes: "moved" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.tableNumber, other.tableNumber);
  assert.equal((await api("PATCH", `/bookings/${a.id}`, { startTime: "13:00" })).status, 400, "time changes need date+time+duration");

  await api("POST", `/bookings/${a.id}/cancel`);
  assert.equal((await api("PATCH", `/bookings/${a.id}`, { notes: "x" })).status, 409, "cancelled bookings can't be changed");
});

test("confirm and cancel transitions", async () => {
  const table = await addTable();
  const c = await addCustomer("Flow");
  const b = (await book(table.id, c.id, "15:00")).body.data;
  const confirmed = await api("POST", `/bookings/${b.id}/confirm`);
  assert.equal(confirmed.body.data.status, "confirmed");
  assert.equal((await api("POST", `/bookings/${b.id}/confirm`)).status, 409);
  const cancelled = await api("POST", `/bookings/${b.id}/cancel`, { reason: "Rain" });
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.equal(cancelled.body.data.cancelReason, "Rain");
  assert.equal((await api("POST", `/bookings/${b.id}/cancel`)).status, 409);
});

// ---------- No-shows ----------

test("automatic no-show after the grace minutes (from Settings)", async () => {
  const table = await addTable();
  const c = await addCustomer("Late Larry");
  const b = (await book(table.id, c.id, "16:00")).body.data;
  await moveStart(b.id, -20); // started 20 minutes ago, nobody checked in

  await api("PATCH", "/settings", { noShowGraceMinutes: 30 });
  assert.equal((await api("GET", `/bookings?customerId=${c.id}`)).body.data.bookings[0].status, "pending", "20 < 30 grace minutes");

  await api("PATCH", "/settings", { noShowGraceMinutes: 15 });
  const after = (await api("GET", `/bookings?customerId=${c.id}`)).body.data.bookings[0];
  assert.equal(after.status, "no_show");
  assert.ok(after.noShowAt);

  const checkIn = await api("POST", `/bookings/${b.id}/check-in`);
  assert.equal(checkIn.status, 409);
  assert.equal(checkIn.body.message, "This booking was marked as a no-show (the customer didn't arrive in time)");
  assert.equal((await api("GET", `/tables/${table.id}`)).body.data.status, "available", "no-shows don't change the table");
});

// ---------- Check-in ----------

test("check-in: starts a linked session on the booked table", async () => {
  const table = await addTable({ name: "Check-in Table" });
  const c = await addCustomer("Arrived Ali");
  const b = (await book(table.id, c.id, "16:00")).body.data;
  await moveStart(b.id, 10); // starts in 10 minutes -> check-in is open

  const { status, body } = await api("POST", `/bookings/${b.id}/check-in`);
  assert.equal(status, 200);
  assert.equal(body.message, `Arrived Ali checked in · session started on Table ${table.tableNumber}`);
  assert.equal(body.data.booking.status, "completed");
  assert.equal(body.data.booking.session, body.data.session.id);
  assert.equal(body.data.session.booking, b.id);
  assert.equal(body.data.session.status, "active");
  assert.equal((await api("GET", `/tables/${table.id}`)).body.data.status, "occupied");

  const again = await api("POST", `/bookings/${b.id}/check-in`);
  assert.equal(again.status, 409);
  assert.equal(again.body.message, "This booking is already checked in");

  const profile = (await api("GET", `/customers/${c.id}`)).body.data;
  assert.equal(profile.stats.completed, 1);
  assert.equal(profile.bookings[0].sessionInfo.status, "active");
});

test("check-in: too early, reserved table OK, maintenance/occupied refused, races", async () => {
  const c = await addCustomer("Rules");

  const early = await addTable();
  const earlyBooking = (await book(early.id, c.id, "16:00")).body.data; // tomorrow
  const tooEarly = await api("POST", `/bookings/${earlyBooking.id}/check-in`);
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.message, /^Check-in opens at \d{1,2}:\d{2} (am|pm) \(30 minutes before the booking\)$/);

  const reserved = await addTable({ status: "reserved" });
  const rb = (await book(reserved.id, c.id, "16:00")).body.data;
  await moveStart(rb.id, 5);
  assert.equal((await api("POST", `/bookings/${rb.id}/check-in`)).status, 200, "a table reserved by hand can be checked in");

  const broken = await addTable({ status: "maintenance" });
  const mb = (await book(broken.id, c.id, "16:00")).body.data;
  await moveStart(mb.id, 5);
  const refused = await api("POST", `/bookings/${mb.id}/check-in`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.message, `Table ${broken.tableNumber} is under maintenance. Free the table before checking in this booking.`);
  assert.equal((await api("GET", `/bookings/${mb.id}`)).body.data.status, "pending", "booking unchanged after a refused check-in");

  const busy = await addTable();
  const ob = (await book(busy.id, c.id, "16:00")).body.data;
  await api("POST", "/sessions", { tableId: busy.id }); // a walk-in is playing
  await moveStart(ob.id, 5);
  assert.equal((await api("POST", `/bookings/${ob.id}/check-in`)).status, 409);

  const race = await addTable();
  const rcb = (await book(race.id, c.id, "16:00")).body.data;
  await moveStart(rcb.id, 0);
  const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", `/bookings/${rcb.id}/check-in`)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
  assert.equal(await db().collection("sessions").countDocuments({ table: oid(race.id) }), 1);
});

// ---------- Lists, availability, related modules ----------

test("list a day, availability view, dashboard counts, and table delete protection", async () => {
  const table = await addTable({ name: "Day View" });
  const c = await addCustomer("Viewer");
  const late = (await book(table.id, c.id, "23:30", 90)).body.data; // runs past midnight
  const early = (await book(table.id, c.id, "10:00", 60)).body.data;

  const day = (await api("GET", `/bookings?date=${TOMORROW}&tableId=${table.id}`)).body.data;
  assert.deepEqual(day.bookings.map((b) => b.id), [early.id, late.id], "a day is listed in time order");
  assert.equal((await api("GET", `/bookings?status=active&search=viewer`)).body.data.total, 2);

  const availability = (await api("GET", `/bookings/availability?date=${TOMORROW}`)).body.data;
  const row = availability.tables.find((t) => t.id === table.id);
  assert.deepEqual(row.bookings.map((b) => b.id), [early.id, late.id]);
  const nextDay = clubDate(2);
  const spill = (await api("GET", `/bookings/availability?date=${nextDay}`)).body.data.tables.find((t) => t.id === table.id);
  assert.deepEqual(spill.bookings.map((b) => b.id), [late.id], "23:30 + 90 min also shows on the next day");
  assert.equal((await api("GET", "/bookings/availability")).status, 400);

  const dashboard = (await api("GET", `/dashboard/summary?date=${TOMORROW}`)).body.data;
  assert.ok(dashboard.today.bookingCount >= 2);
  assert.ok(dashboard.upcomingBookings.some((b) => b.id === early.id));

  const del = await api("DELETE", `/tables/${table.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.message, `Table ${table.tableNumber} has 2 upcoming booking(s). Cancel or move them before deleting the table.`);
});
