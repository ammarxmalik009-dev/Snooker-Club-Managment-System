// Tests for Phase 3, Group 2's HTTP wiring: server/middleware/auth.js,
// server/controllers/auth.controller.js and server/controllers/users.controller.js now require
// the cutover adapters (authCutover.service.js / usersCutover.service.js) instead of
// auth.service.js / users.service.js directly - the only change this step made to those three
// files. "users" is NOT a recognised cutover route group (server/config/cutover.js's own
// KNOWN_ROUTE_GROUPS still only has "settings"), so every one of these tests runs against the
// real, unmodified MongoDB path - proving the wiring is transparent, not that PostgreSQL is
// live (it isn't, and this file does not claim otherwise).
//
// Needs the real MongoDB test database (npm run db) - the same as every other HTTP-level
// server test file.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb");
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");

const TEST_DB_URI = process.env.MONGODB_USERSAUTHWIRING_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_usersauthwiring";

let server;
let baseUrl;

async function api(method, path, { body, cookie } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json(), headers: response.headers };
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
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await dropTestDatabase();
  await mongoose.disconnect();
});

test("wiring check: middleware/auth.js, auth.controller.js and users.controller.js now require the cutover adapters, not the raw MongoDB services directly", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  assert.match(read("middleware/auth.js"), /require\("\.\.\/services\/authCutover\.service"\)/);
  assert.match(read("controllers/auth.controller.js"), /require\("\.\.\/services\/authCutover\.service"\)/);
  assert.match(read("controllers/users.controller.js"), /require\("\.\.\/services\/usersCutover\.service"\)/);
  // And NOT the raw services directly - confirming this is a genuine swap, not an addition
  // alongside the old require.
  assert.doesNotMatch(read("middleware/auth.js"), /require\("\.\.\/services\/auth\.service"\)/);
  assert.doesNotMatch(read("controllers/auth.controller.js"), /require\("\.\.\/services\/auth\.service"\)/);
  assert.doesNotMatch(read("controllers/users.controller.js"), /require\("\.\.\/services\/users\.service"\)/);
});

test("1. MongoDB login works exactly as before, through the now-wired HTTP path", async () => {
  const cookie = await loginAs(baseUrl, "admin");
  const me = await api("GET", "/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.username, "test-admin");
  assert.match(me.body.data.id, /^[0-9a-f]{24}$/, "a real MongoDB ObjectId, since the users route group is not cutover-activated");
});

test("2. invalid credentials remain rejected with the same generic error", async () => {
  const result = await api("POST", "/auth/login", { body: { username: "test-admin", password: "wrong-password" } });
  assert.equal(result.status, 401);
  assert.equal(result.body.message, "Invalid username or password.");
});

test("3. logout invalidates the MongoDB session - the same cookie is refused afterward", async () => {
  const cookie = await loginAs(baseUrl, "admin");
  const before = await api("GET", "/auth/me", { cookie });
  assert.equal(before.status, 200);

  await api("POST", "/auth/logout", { cookie });

  const after = await api("GET", "/auth/me", { cookie });
  assert.equal(after.status, 401, "the exact same cookie, which worked a moment ago, is now refused - the session itself was invalidated, not merely a client-side cookie clear");
});

test("4. protected routes still require authentication - no cookie at all", async () => {
  const result = await api("GET", "/auth/me");
  assert.equal(result.status, 401);
  const usersResult = await api("GET", "/users");
  assert.equal(usersResult.status, 401);
});

test("5. existing role restrictions remain unchanged - staff cannot manage users", async () => {
  const staffCookie = await loginAs(baseUrl, "staff");
  const result = await api("GET", "/users", { cookie: staffCookie });
  assert.equal(result.status, 403);
});

test("6. no production forcePg bypass exists: a header, query parameter or body field named forcePg has ZERO effect on which backend answers", async () => {
  const cookie = await loginAs(baseUrl, "admin");
  // Try every plausible place a hidden override could be smuggled in - none of them reach the
  // adapter's own `forcePg` parameter, because the controller/middleware code never reads any
  // of these and never threads request data into that parameter at all (confirmed by reading
  // the actual wired files above - this test proves the OBSERVABLE behaviour matches).
  const viaHeader = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie, "X-Force-Pg": "true", "forcePg": "true" } });
  const viaQuery = await fetch(`${baseUrl}/api/auth/me?forcePg=true`, { headers: { Cookie: cookie } });
  const bodyAttempt = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ username: "test-admin", password: "wrong-on-purpose", forcePg: true }),
  });
  for (const response of [viaHeader, viaQuery]) {
    const result = await response.json();
    assert.match(result.data.id, /^[0-9a-f]{24}$/, "still a MongoDB ObjectId - the header/query attempt changed nothing");
  }
  assert.equal(bodyAttempt.status, 401, "a forcePg field in the login body is just an unrecognised extra field - login still fails on the deliberately wrong password, via MongoDB, exactly as it would without it");
});

test("isolation note: PostgreSQL HTTP-level integration for Users/Auth cannot be tested without activating the real route group, and was NOT faked here - see server/tests/postgresUsersAuthCutover.test.js for the adapter/controller CONTRACT tested directly with an explicit, test-only override instead", () => {
  const { KNOWN_ROUTE_GROUPS } = require("../config/cutover");
  assert.ok(!KNOWN_ROUTE_GROUPS.includes("users"), "confirmed once more, from this file too: there is still no way to activate this through the real HTTP path");
});
