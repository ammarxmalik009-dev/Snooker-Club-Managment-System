// Genuine HTTP end-to-end test for PostgreSQL-backed Users/Auth (Step 34).
//
// Two existing files are NOT this: server/tests/postgresUsersAuthCutover.test.js calls the
// cutover adapters' exported functions directly (no Express app, no real HTTP request) - it
// proves the adapter's own CONTRACT, not that a real HTTP request reaches PostgreSQL.
// server/tests/usersAuthWiring.test.js makes real HTTP requests through the real app, but
// "users" is not a recognised cutover route group (server/config/cutover.js's own
// KNOWN_ROUTE_GROUPS is still just ["settings"]), so every one of ITS requests goes through
// MongoDB - it cannot and does not claim otherwise.
//
// THIS file starts the real createApp(), sends real fetch() requests, and makes the Users/Auth
// adapters delegate to PostgreSQL for the duration of specific sub-tests - without touching
// server/config/cutover.js, without any production forcePg bypass, and without changing any
// shipped file.
//
// How the forcing works (verified safe BEFORE relying on it - see test "0" below, which checks
// this at runtime, not just by reading the code): server/routes/index.js -> auth.routes.js /
// users.routes.js -> auth.controller.js / users.controller.js / middleware/auth.js all call
// `authService.login(...)`, `authService.resolveSession(...)`, `usersService.listUsers(...)`
// etc. as a PLAIN PROPERTY ACCESS on the already-`require()`-d adapter module object - never a
// destructured local copy of the function. Node's require() cache means every one of those
// requires resolves to the exact same object this test file also requires. Replacing a function
// ON THAT OBJECT, in this one test process, is therefore observed by the real, running Express
// app. The replacement exists only as in-memory properties on a module object inside this
// process; it is restored in every sub-test's own `finally`/`t.after`, and reading
// server/config/cutover.js's PG_CUTOVER_ROUTES is never involved - real traffic's selector is
// completely untouched by anything in this file.
//
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (this project's own convention) - SKIPPED with a
// clear reason otherwise. Scenario 8 (cross-backend session isolation) additionally needs a
// real MongoDB test database (same MONGODB_URI convention every other HTTP test file uses) -
// that half is skipped on its own, separately, if MongoDB isn't reachable, never silently.
//
// No mocks for the PostgreSQL half: every HTTP response below is produced by the real
// auth.pg.service.js / users.pg.service.js / authSessions.pg.service.js code, against a real,
// isolated PostgreSQL test database - the same convention server/tests/postgresUsersAuth.test.js
// already uses (DROP SCHEMA + real migrations, the shared advisory lock, no raw SQL shortcuts).

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");
const { dropTestDatabase } = require("./helpers/testDb");

const TEST_URL = getPgTestDatabaseUrl();
let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Phase 3, Group 2") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const MONGO_TEST_DB_URI = process.env.MONGODB_PGHTTP_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_pghttp";

test(
  "Phase 3 Group 2 (Step 34): genuine HTTP end-to-end test for PostgreSQL-backed Users/Auth, through the real Express app",
  { skip: skipReason },
  async (t) => {
    const { getPool, closePool } = require("../config/db.pg");
    const migrate = require("../db/migrate");
    const usersPg = require("../services/users.pg.service");
    const authCutoverService = require("../services/authCutover.service");
    const usersCutoverService = require("../services/usersCutover.service");
    const { createApp } = require("../app");

    const lockClient = await lockAppSchema(getPool());
    let server, baseUrl, mongoConnected = false;
    const callLog = []; // proof the real PostgreSQL service functions were invoked, not inferred only from HTTP status codes

    const originalAuth = {};
    const originalUsers = {};
    for (const name of ["login", "resolveSession", "logout", "endAllSessionsForUser"]) originalAuth[name] = authCutoverService[name];
    for (const name of ["listUsers", "getUserById", "createUser", "updateUser", "setPassword", "countActiveAdmins"]) originalUsers[name] = usersCutoverService[name];

    function forcePg() {
      authCutoverService.login = (params, opts = {}) => { callLog.push("auth.login"); return originalAuth.login(params, { ...opts, forcePg: true }); };
      authCutoverService.resolveSession = (token, opts = {}) => { callLog.push("auth.resolveSession"); return originalAuth.resolveSession(token, { ...opts, forcePg: true }); };
      authCutoverService.logout = (token, opts = {}) => { callLog.push("auth.logout"); return originalAuth.logout(token, { ...opts, forcePg: true }); };
      authCutoverService.endAllSessionsForUser = (userId, opts = {}) => { callLog.push("auth.endAllSessionsForUser"); return originalAuth.endAllSessionsForUser(userId, { ...opts, forcePg: true }); };
      usersCutoverService.listUsers = (filters, opts = {}) => { callLog.push("users.listUsers"); return originalUsers.listUsers(filters, { ...opts, forcePg: true }); };
      usersCutoverService.getUserById = (id, opts = {}) => { callLog.push("users.getUserById"); return originalUsers.getUserById(id, { ...opts, forcePg: true }); };
      usersCutoverService.createUser = (data, actorUser, opts = {}) => { callLog.push("users.createUser"); return originalUsers.createUser(data, actorUser, { ...opts, forcePg: true }); };
      usersCutoverService.updateUser = (id, changes, actorUser, opts = {}) => { callLog.push("users.updateUser"); return originalUsers.updateUser(id, changes, actorUser, { ...opts, forcePg: true }); };
      usersCutoverService.setPassword = (id, password, actorUser, options = {}) => { callLog.push("users.setPassword"); return originalUsers.setPassword(id, password, actorUser, { ...options, forcePg: true }); };
      usersCutoverService.countActiveAdmins = (opts = {}) => { callLog.push("users.countActiveAdmins"); return originalUsers.countActiveAdmins({ ...opts, forcePg: true }); };
    }
    function restorePg() {
      Object.assign(authCutoverService, originalAuth);
      Object.assign(usersCutoverService, originalUsers);
    }

    t.after(async () => {
      restorePg();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
      await unlockAppSchema(lockClient);
      await closePool();
      if (mongoConnected) {
        await dropTestDatabase();
        await mongoose.disconnect();
      }
    });

    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
    await migrate.runMigrations();

    const STRONG_PASSWORD = "Snooker-cue-http-2026";
    await usersPg.createFirstAdmin({ name: "HTTP Admin", username: "http.admin", password: STRONG_PASSWORD });
    await usersPg.createUser({ name: "HTTP Staff", username: "http.staff", role: "staff", password: STRONG_PASSWORD });

    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function api(method, path, { body, cookie } = {}) {
      const options = { method, headers: {} };
      if (cookie) options.headers.Cookie = cookie;
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const response = await fetch(`${baseUrl}/api${path}`, options);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, body: data, headers: response.headers };
    }

    await t.test("0. sanity: the running Express app really calls the exact property this file patches - checked at runtime before any later test relies on it", async () => {
      // Forced to PostgreSQL first (MongoDB isn't connected in this process yet - that's only
      // set up for test 8 - so the UN-forced default path can't be exercised here without a
      // real MongoDB connection; PostgreSQL's own resolveSession needs no such setup).
      forcePg();
      let sawCall = false;
      const forced = authCutoverService.resolveSession;
      authCutoverService.resolveSession = (...args) => { sawCall = true; return forced(...args); };
      try {
        const result = await api("GET", "/auth/me", { cookie: "scp_session=not-a-real-token" });
        assert.equal(result.status, 401);
        assert.ok(sawCall, "a real HTTP request, through middleware/auth.js's loadUser, reached the exact function this test patches - not a separate, uncached copy");
      } finally {
        restorePg();
      }
    });

    await t.test("1-7. PostgreSQL admin login through the real HTTP endpoint, the real session-cookie contract, the protected users-list route, role restriction, logout and session invalidation", async () => {
      forcePg();
      try {
        // 1 & 2: real HTTP login, real session-cookie contract
        const loginResult = await api("POST", "/auth/login", { body: { username: "http.admin", password: STRONG_PASSWORD } });
        assert.equal(loginResult.status, 200, JSON.stringify(loginResult.body));
        const setCookie = loginResult.headers.get("set-cookie");
        assert.match(setCookie, /^scp_session=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Strict/i);
        const cookie = setCookie.split(";")[0];
        assert.match(
          loginResult.body.data.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          "a real PostgreSQL UUID, not a MongoDB ObjectId - proof this really went through the PostgreSQL path, not just a 200 status"
        );

        // 3: the returned session allows access to a protected users-list route
        const list = await api("GET", "/users", { cookie });
        assert.equal(list.status, 200, JSON.stringify(list.body));
        assert.ok(list.body.data.users.some((u) => u.username === "http.admin"));
        assert.ok(!("passwordHash" in list.body.data.users[0]), "no password hash is ever serialized over HTTP");

        // 4: unauthenticated request to the same protected route is rejected
        const noAuth = await api("GET", "/users");
        assert.equal(noAuth.status, 401);

        // 5: a lower-privilege PostgreSQL user is denied the admin-only route, via the app's own real permission rule (config/permissions.js's "users:manage")
        const staffLogin = await api("POST", "/auth/login", { body: { username: "http.staff", password: STRONG_PASSWORD } });
        assert.equal(staffLogin.status, 200);
        const staffCookie = staffLogin.headers.get("set-cookie").split(";")[0];
        const staffList = await api("GET", "/users", { cookie: staffCookie });
        assert.equal(staffList.status, 403);

        // 6: logout invalidates the PostgreSQL session
        const logoutResult = await api("POST", "/auth/logout", { cookie });
        assert.equal(logoutResult.status, 200);

        // 7: reusing the logged-out session cannot access the protected route
        const afterLogout = await api("GET", "/users", { cookie });
        assert.equal(afterLogout.status, 401);
      } finally {
        restorePg();
      }
    });

    await t.test("8. cross-backend session isolation: a MongoDB session is not accepted as a PostgreSQL session, and a PostgreSQL session is not accepted as a MongoDB session", async (t2) => {
      const mongoReady = await mongoose
        .connect(MONGO_TEST_DB_URI, { serverSelectionTimeoutMS: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!mongoReady) {
        t2.skip("MongoDB is not reachable at " + MONGO_TEST_DB_URI.replace(/\/\/.*@/, "//***@") + " - start it with: npm run db");
        return;
      }
      mongoConnected = true;
      await dropTestDatabase();
      await mongoose.connection.syncIndexes();
      const { createUser: createMongoUser } = require("../services/users.service");
      await createMongoUser({ name: "Mongo Admin", username: "mongo.admin", role: "admin", password: STRONG_PASSWORD });

      // A real MongoDB login, through the REAL (not forced) selector - today's actual default.
      const mongoLogin = await api("POST", "/auth/login", { body: { username: "mongo.admin", password: STRONG_PASSWORD } });
      assert.equal(mongoLogin.status, 200);
      const mongoCookie = mongoLogin.headers.get("set-cookie").split(";")[0];
      assert.match(mongoLogin.body.data.id, /^[0-9a-f]{24}$/, "a real MongoDB ObjectId, confirming this login really went through MongoDB (today's real default)");

      forcePg();
      try {
        const mongoOnPg = await api("GET", "/auth/me", { cookie: mongoCookie });
        assert.equal(mongoOnPg.status, 401, "a MongoDB session is never accepted as a PostgreSQL one");

        const pgLogin = await api("POST", "/auth/login", { body: { username: "http.admin", password: STRONG_PASSWORD } });
        assert.equal(pgLogin.status, 200);
        const pgCookie = pgLogin.headers.get("set-cookie").split(";")[0];

        restorePg(); // back to the real selector - today, that means MongoDB again
        const pgOnMongo = await api("GET", "/auth/me", { cookie: pgCookie });
        assert.equal(pgOnMongo.status, 401, "a PostgreSQL session is never accepted as a MongoDB one");

        const mongoStillWorks = await api("GET", "/auth/me", { cookie: mongoCookie });
        assert.equal(mongoStillWorks.status, 200, "the MongoDB cookie still works under the real selector - this test's own excursion into forcePg() left nothing broken");
      } finally {
        restorePg();
      }
    });

    await t.test("9. confirms the intended PostgreSQL service functions were really called during this run, not just inferred from HTTP status codes", () => {
      for (const name of ["auth.login", "auth.resolveSession", "auth.logout", "users.listUsers", "users.countActiveAdmins"]) {
        assert.ok(callLog.includes(name), `${name} was called at least once through the forced-PostgreSQL adapter`);
      }
    });
  }
);
