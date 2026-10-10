// Automatic tests for login, logout, sessions, permissions and user management (Phase 8).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs, TEST_PASSWORD } = require("./helpers/auth");
const { User } = require("../models/User");

const TEST_DB_URI = process.env.MONGODB_AUTH_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_auth";
const STRONG = "Snooker-cue-2026";

let server;
let baseUrl;
const cookies = {}; // role -> cookie

async function call(method, path, { cookie, body, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

async function login(username, password) {
  return call("POST", "/auth/login", { body: { username, password } });
}

const cookieOf = (response) => (response.headers.get("set-cookie") || "").split(";")[0];

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
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState === 1) await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------- Login / me / logout ----------

test("login sets a secure httpOnly cookie; /me returns safe user info", async () => {
  const response = await login(" Test-Staff ", TEST_PASSWORD); // username is normalized
  assert.equal(response.status, 200);
  assert.equal(response.body.message, "Welcome, Test staff");
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^scp_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=43200/); // 12 hours

  const me = await call("GET", "/auth/me", { cookie: cookieOf(response) });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.body.data).sort(), ["active", "id", "name", "permissions", "role", "username"]);
  assert.equal(me.body.data.username, "test-staff");
  assert.equal(me.body.data.role, "staff");
  assert.ok(me.body.data.permissions.includes("bills:create"));
  assert.ok(!me.body.data.permissions.includes("settings:manage"));
  assert.ok(!JSON.stringify(me.body).includes("passwordHash"));

  const stored = await mongoose.connection.collection("users").findOne({ username: "test-staff" });
  assert.ok(stored.lastLoginAt, "lastLoginAt is recorded");
  assert.match(stored.passwordHash, /^scrypt\$16384\$8\$1\$/, "password stored as an scrypt hash");
  assert.ok(!stored.passwordHash.includes(TEST_PASSWORD));
});

test("wrong password, unknown user and bad input all get the same generic answer", async () => {
  const wrong = await login("test-admin", "Wrong-password-1");
  const unknown = await login("nobody-here", "Wrong-password-1");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, { success: false, message: "Invalid username or password." });
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const empty = await call("POST", "/auth/login", { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.message, "Please correct the highlighted fields");
});

test("/me and protected APIs: 401 without a login, with a fake cookie, and after logout", async () => {
  assert.equal((await call("GET", "/auth/me")).status, 401);
  assert.equal((await call("GET", "/auth/me", { cookie: "scp_session=not-a-real-token" })).status, 401);

  const session = cookieOf(await login("test-cashier", TEST_PASSWORD));
  assert.equal((await call("GET", "/tables", { cookie: session })).status, 200);
  const out = await call("POST", "/auth/logout", { cookie: session });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /scp_session=;/);
  assert.equal((await call("GET", "/tables", { cookie: session })).status, 401, "the old cookie no longer works");
});

test("expired sessions are refused (401)", async () => {
  const session = cookieOf(await login("test-admin", TEST_PASSWORD));
  await mongoose.connection.collection("authsessions").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const response = await call("GET", "/auth/me", { cookie: session });
  assert.equal(response.status, 401);
  cookies.admin = await loginAs(baseUrl, "admin");
  cookies.staff = await loginAs(baseUrl, "staff");
  cookies.cashier = await loginAs(baseUrl, "cashier");
});

test("session tokens are stored only as an HMAC, never in plain text", async () => {
  const token = cookies.admin.split("=")[1];
  const sessions = await mongoose.connection.collection("authsessions").find({}).toArray();
  assert.ok(sessions.length > 0);
  assert.ok(sessions.every((s) => /^[a-f0-9]{64}$/.test(s.tokenHash) && s.tokenHash !== token));
  assert.ok(!JSON.stringify(sessions).includes(token));
});

test("requests from another website can't change anything", async () => {
  const response = await call("POST", "/tables", { cookie: cookies.admin, body: { tableNumber: 77, hourlyRate: 1 }, headers: { Origin: "http://evil.example" } });
  assert.equal(response.status, 403);
  assert.equal(response.body.message, "Requests from other websites are not allowed.");
});

// ---------- Permissions (checked directly on the API, not through the UI) ----------

test("permission matrix: every role, every module", async () => {
  // A finished session with a bill to work with
  await call("PATCH", "/settings", { cookie: cookies.admin, body: { centuryPrice: 30000, framePrice: 15000 } });
  const table = (await call("POST", "/tables", { cookie: cookies.admin, body: { tableNumber: 1, hourlyRate: 60000 } })).body.data;
  const session = (await call("POST", "/sessions", { cookie: cookies.admin, body: { tableId: table.id } })).body.data;
  await call("POST", `/sessions/${session.id}/end`, { cookie: cookies.admin });
  const bill = (await call("POST", "/bills", { cookie: cookies.admin, body: {
    sessionId: session.id, gameMode: "century", quantity: 1, payerRule: "loser", players: [{ name: "Ali", result: "loser" }, { name: "Usman" }],
  } })).body.data;

  const id = "0123456789abcdef01234567"; // a well-formed id that doesn't exist -> 404 when allowed
  const checks = [
    // [method, path, body, expected for admin, staff, cashier]
    ["GET", "/dashboard/summary", undefined, [200, 200, 200]],
    ["GET", "/tables", undefined, [200, 200, 200]],
    ["GET", "/sessions/active", undefined, [200, 200, 200]],
    ["GET", "/customers", undefined, [200, 200, 200]],
    ["GET", "/bookings?date=2026-10-07", undefined, [200, 200, 200]],
    ["GET", "/bills", undefined, [200, 200, 200]],
    ["GET", `/bills/${bill.id}`, undefined, [200, 200, 200]],          // includes payments
    ["GET", "/settings", undefined, [200, 200, 200]],                   // read: the bill window shows prices
    ["PATCH", "/settings", { centuryPrice: 31000 }, [200, 403, 403]],   // change: admin only
    ["PATCH", "/settings", { taxEnabled: true, taxRateBasisPoints: 1600 }, [200, 403, 403]],
    ["PATCH", "/settings", { minimumBillableMinutes: 20 }, [200, 403, 403]],
    ["PATCH", "/settings", { noShowGraceMinutes: 30 }, [200, 403, 403]],
    ["GET", "/users", undefined, [200, 403, 403]],
    ["POST", "/users", { name: "X", username: "x1", role: "staff", password: STRONG }, [400, 403, 403]],
    ["PATCH", `/users/${id}`, { name: "Nobody" }, [404, 403, 403]],
    ["POST", `/users/${id}/password`, { password: STRONG }, [404, 403, 403]],
    ["POST", "/bills/preview", { sessionId: id, gameMode: "century", quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] }, [404, 404, 404]],
    ["POST", `/bills/${id}/payments`, { amount: 100, method: "cash", payerName: "Ali" }, [404, 403, 404]], // staff: view payments only
    ["POST", `/bills/${id}/cancel`, {}, [404, 403, 404]],
    ["POST", "/tables", { tableNumber: 99, hourlyRate: 1 }, [201, 409, 409]],
    ["POST", `/bookings/${id}/cancel`, {}, [404, 404, 404]],
    ["DELETE", `/customers/${id}`, undefined, [404, 404, 404]],
  ];
  const roles = ["admin", "staff", "cashier"];
  for (const [method, path, body, expected] of checks) {
    const actual = [];
    for (const role of roles) actual.push((await call(method, path, { cookie: cookies[role], body })).status);
    assert.deepEqual(actual, expected, `${method} ${path}`);
  }
  // The forbidden ones say so clearly
  const forbidden = await call("PATCH", "/settings", { cookie: cookies.staff, body: { centuryPrice: 1 } });
  assert.deepEqual(forbidden.body, { success: false, message: "You don't have permission to do this." });
  assert.equal((await call("GET", "/settings", { cookie: cookies.admin })).body.data.centuryPrice, 31000, "staff/cashier changes were not applied");
  await call("PATCH", "/settings", { cookie: cookies.admin, body: { taxEnabled: false, taxRateBasisPoints: 0, minimumBillableMinutes: 15, noShowGraceMinutes: 15 } });
});

test("EVERY API route rejects requests without a login (401)", async () => {
  const id = "0123456789abcdef01234567";
  const routes = [
    "GET /tables", "GET /tables/summary", `GET /tables/${id}`, "POST /tables", `PATCH /tables/${id}`, `DELETE /tables/${id}`,
    "GET /sessions", "GET /sessions/active", `GET /sessions/${id}`, "POST /sessions", `POST /sessions/${id}/end`,
    "POST /bills/preview", "GET /bills", "POST /bills", `GET /bills/${id}`, `POST /bills/${id}/cancel`, `POST /bills/${id}/payments`,
    "GET /settings", "PATCH /settings", "GET /dashboard/summary",
    "GET /customers", `GET /customers/${id}`, "POST /customers", `PATCH /customers/${id}`, `DELETE /customers/${id}`,
    "GET /bookings", "GET /bookings/availability", `GET /bookings/${id}`, "POST /bookings", `PATCH /bookings/${id}`,
    `POST /bookings/${id}/confirm`, `POST /bookings/${id}/cancel`, `POST /bookings/${id}/check-in`,
    "GET /users", `GET /users/${id}`, "POST /users", `PATCH /users/${id}`, `POST /users/${id}/password`,
    "GET /auth/me", "GET /anything-else",
  ];
  for (const route of routes) {
    const [method, path] = route.split(" ");
    const response = await call(method, path, { body: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(response.status, 401, route);
  }
  // Logged in, an unknown endpoint is a normal 404
  assert.equal((await call("GET", "/anything-else", { cookie: cookies.staff })).status, 404);
  // Public on purpose
  assert.equal((await call("GET", "/health")).status, 200);
});

// ---------- Audit ----------

test("audit: bills, payments, bookings, sessions and settings record who did it", async () => {
  const table = (await call("POST", "/tables", { cookie: cookies.cashier, body: { tableNumber: 5, hourlyRate: 1 } })).body.data;
  const session = (await call("POST", "/sessions", { cookie: cookies.staff, body: { tableId: table.id } })).body.data;
  assert.deepEqual([session.startedBy.username, session.startedBy.name], ["test-staff", "Test staff"]);
  const ended = (await call("POST", `/sessions/${session.id}/end`, { cookie: cookies.cashier })).body.data;
  assert.equal(ended.endedBy.username, "test-cashier");

  const bill = (await call("POST", "/bills", { cookie: cookies.staff, body: {
    sessionId: session.id, gameMode: "frame", quantity: 2, payerRule: "split", players: [{ name: "A" }, { name: "B" }],
  } })).body.data;
  assert.equal(bill.createdBy.username, "test-staff");
  assert.equal(bill.total, 30000, "billing maths unchanged by logins");

  const paid = await call("POST", `/bills/${bill.id}/payments`, { cookie: cookies.cashier, body: { amount: 15000, method: "cash", payerName: "A" } });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.data.payment.receivedBy.username, "test-cashier");
  const over = await call("POST", `/bills/${bill.id}/payments`, { cookie: cookies.cashier, body: { amount: 15001, method: "cash", payerName: "B" } });
  assert.equal(over.status, 409, "overpayment protection still works");

  const settings = (await call("PATCH", "/settings", { cookie: cookies.admin, body: { framePrice: 15000 } })).body.data;
  assert.equal(settings.updatedBy.username, "test-admin");

  const customer = (await call("POST", "/customers", { cookie: cookies.staff, body: { name: "Audit Ali" } })).body.data;
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() + 864e5));
  const booking = (await call("POST", "/bookings", { cookie: cookies.staff, body: { customerId: customer.id, tableId: table.id, date: tomorrow, startTime: "18:00", durationMinutes: 60 } })).body.data;
  assert.equal(booking.createdBy.username, "test-staff");
  const cancelled = (await call("POST", `/bookings/${booking.id}/cancel`, { cookie: cookies.cashier, body: {} })).body.data;
  assert.equal(cancelled.cancelledBy.username, "test-cashier");
});

// ---------- User management ----------

test("create users: normalized unique usernames, strong passwords, no hashes in responses", async () => {
  const created = await call("POST", "/users", { cookie: cookies.admin, body: { name: "Kamran", username: "  Kamran.Staff ", role: "staff", password: STRONG } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.username, "kamran.staff");
  assert.equal(created.body.data.createdBy.username, "test-admin");
  assert.equal(created.body.data.passwordHash, undefined);

  const duplicate = await call("POST", "/users", { cookie: cookies.admin, body: { name: "Other", username: "KAMRAN.STAFF", role: "cashier", password: STRONG } });
  assert.equal(duplicate.status, 409);

  const cases = [
    [{ name: "A", username: "abc", role: "staff", password: STRONG }, "Name must be 2 to 60 characters"],
    [{ name: "Abc", username: "a b", role: "staff", password: STRONG }, "Username must be 3-30 letters, numbers, dots, dashes or underscores"],
    [{ name: "Abc", username: "abc", role: "owner", password: STRONG }, "Role must be one of: admin, staff, cashier"],
    [{ name: "Abc", username: "abc", role: "staff", password: "short1" }, "Password must be at least 10 characters"],
    [{ name: "Abc", username: "abc", role: "staff", password: "onlyletters" }, "Password must contain both letters and numbers"],
    [{ name: "Abc", username: "abcdef", role: "staff", password: "abcdef12345" }, "Password must not contain the username"],
  ];
  for (const [body, message] of cases) {
    const response = await call("POST", "/users", { cookie: cookies.admin, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok(response.body.message === message || (response.body.errors || []).some((e) => e.message === message), `${JSON.stringify(body)} -> ${JSON.stringify(response.body)}`);
  }

  const list = await call("GET", "/users?search=kamran", { cookie: cookies.admin });
  assert.equal(list.body.data.users.length, 1);
  assert.ok(!JSON.stringify(list.body).includes("scrypt"), "no password hashes anywhere in the list");

  const newLogin = await login("kamran.staff", STRONG);
  assert.equal(newLogin.status, 200);
});

test("deactivated users can't log in and lose their existing logins at once", async () => {
  await call("POST", "/users", { cookie: cookies.admin, body: { name: "Leaving", username: "leaving", role: "cashier", password: STRONG } });
  const theirCookie = cookieOf(await login("leaving", STRONG));
  const user = (await call("GET", "/users?search=leaving", { cookie: cookies.admin })).body.data.users[0];

  const off = await call("PATCH", `/users/${user.id}`, { cookie: cookies.admin, body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal((await call("GET", "/tables", { cookie: theirCookie })).status, 401, "existing login stops working");
  const again = await login("leaving", STRONG);
  assert.equal(again.status, 401);
  assert.equal(again.body.message, "Invalid username or password.", "same generic message - no hint that the account exists");

  await call("PATCH", `/users/${user.id}`, { cookie: cookies.admin, body: { active: true } });
  assert.equal((await login("leaving", STRONG)).status, 200, "reactivated");
});

test("role changes apply to the next request (no re-login needed)", async () => {
  await call("POST", "/users", { cookie: cookies.admin, body: { name: "Promoted", username: "promoted", role: "staff", password: STRONG } });
  const theirCookie = cookieOf(await login("promoted", STRONG));
  assert.equal((await call("GET", "/users", { cookie: theirCookie })).status, 403);
  const user = (await call("GET", "/users?search=promoted", { cookie: cookies.admin })).body.data.users[0];
  await call("PATCH", `/users/${user.id}`, { cookie: cookies.admin, body: { role: "admin" } });
  assert.equal((await call("GET", "/users", { cookie: theirCookie })).status, 200);
  await call("PATCH", `/users/${user.id}`, { cookie: cookies.admin, body: { role: "cashier" } });
  assert.equal((await call("GET", "/users", { cookie: theirCookie })).status, 403);
});

test("password reset: old password stops working, their other logins end", async () => {
  await call("POST", "/users", { cookie: cookies.admin, body: { name: "Forgetful", username: "forgetful", role: "staff", password: STRONG } });
  const oldCookie = cookieOf(await login("forgetful", STRONG));
  const user = (await call("GET", "/users?search=forgetful", { cookie: cookies.admin })).body.data.users[0];

  const weak = await call("POST", `/users/${user.id}/password`, { cookie: cookies.admin, body: { password: "123" } });
  assert.equal(weak.status, 400);
  assert.equal((await login("forgetful", STRONG)).status, 200, "a refused reset changes nothing");

  const reset = await call("POST", `/users/${user.id}/password`, { cookie: cookies.admin, body: { password: "Brand-new-pass-77" } });
  assert.equal(reset.status, 200);
  assert.equal((await call("GET", "/tables", { cookie: oldCookie })).status, 401);
  assert.equal((await login("forgetful", STRONG)).status, 401);
  assert.equal((await login("forgetful", "Brand-new-pass-77")).status, 200);
});

test("the club can never lose its last active admin", async () => {
  // Make test-admin the only active admin
  await User.updateMany({ role: "admin", username: { $ne: "test-admin" } }, { $set: { active: false } });
  const me = (await call("GET", "/auth/me", { cookie: cookies.admin })).body.data;

  const selfOff = await call("PATCH", `/users/${me.id}`, { cookie: cookies.admin, body: { active: false } });
  assert.equal(selfOff.status, 409);
  assert.equal(selfOff.body.message, "You can't deactivate your own account. Ask another admin.");
  const selfDemote = await call("PATCH", `/users/${me.id}`, { cookie: cookies.admin, body: { role: "staff" } });
  assert.equal(selfDemote.status, 409);
  assert.equal(selfDemote.body.message, "You can't remove your own admin role. Ask another admin.");

  // A second admin can't remove the last one either
  await call("POST", "/users", { cookie: cookies.admin, body: { name: "Second Admin", username: "second.admin", role: "admin", password: STRONG } });
  const secondCookie = cookieOf(await login("second.admin", STRONG));
  const second = (await call("GET", "/users?search=second.admin", { cookie: cookies.admin })).body.data.users[0];
  // second deactivates the first (allowed: second stays) ...
  assert.equal((await call("PATCH", `/users/${me.id}`, { cookie: secondCookie, body: { active: false } })).status, 200);
  // ... now second is the last admin: nobody may remove them (they also can't demote themselves)
  assert.equal((await call("PATCH", `/users/${second.id}`, { cookie: secondCookie, body: { role: "staff" } })).status, 409);
  assert.equal(await User.countDocuments({ role: "admin", active: true }), 1);

  // Two admins deactivating each other at the same moment -> never zero admins
  await call("PATCH", `/users/${me.id}`, { cookie: secondCookie, body: { active: true } });
  cookies.admin = await loginAs(baseUrl, "admin");
  const [a, b] = await Promise.all([
    call("PATCH", `/users/${second.id}`, { cookie: cookies.admin, body: { active: false } }),
    call("PATCH", `/users/${me.id}`, { cookie: secondCookie, body: { active: false } }),
  ]);
  assert.ok(await User.countDocuments({ role: "admin", active: true }) >= 1, `statuses ${a.status}/${b.status}`);
});

test("too many failed logins lock that username for a while (429), same for unknown users", async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await login("kamran.staff", "Wrong-password-9")).status, 401);
  const locked = await login("kamran.staff", STRONG); // even the right password is refused while locked
  assert.equal(locked.status, 429);
  assert.match(locked.body.message, /^Too many login attempts\. Please wait \d+ minute\(s\) and try again\.$/);

  for (let i = 0; i < 5; i += 1) await login("ghost-user", "Wrong-password-9");
  assert.equal((await login("ghost-user", "Wrong-password-9")).status, 429, "unknown usernames behave the same");
});

test("login throttle: clearAll forgets every lock (used by test servers between suites)", () => {
  const throttle = require("../services/loginThrottle");
  const now = Date.now();
  for (let i = 0; i < throttle.LIMITS.ip; i += 1) throttle.recordFailure(`someone-${i}`, "10.9.9.9", now);
  assert.ok(throttle.secondsLocked("anyone", "10.9.9.9", now) > 0, "the IP is locked after too many failures");
  throttle.clearAll();
  assert.equal(throttle.secondsLocked("anyone", "10.9.9.9", now), 0, "nothing is locked after clearAll");
});
