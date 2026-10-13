// Tests for Phase 3 Group 2's additive Users/Auth PostgreSQL service layer: login, session
// resolution/expiry/logout, setPassword, createFirstAdmin, resetAdminPassword, listUsers, and
// session invalidation on deactivation. See docs/POSTGRES_MIGRATION.md's Phase 3 Group 2 section
// for the confirmed, specific reason none of this is wired into any route, middleware or CLI
// script yet (models/schemas/actor.js's ObjectId requirement for `user`, which a PostgreSQL-
// authoritative user's UUID id cannot satisfy while anything else is still MongoDB-authoritative).
//
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real auth.service.js/users.service.js ones, is
// completely unaffected - login, logout, the auth middleware and every route are untouched.
//
// No mocks: every claim below (login, session expiry, no silent fallback, invalidation,
// throttle) is checked against real SQL and the real scrypt/HMAC implementations, never a
// stand-in.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

// COOKIE_NAME/GENERIC_LOGIN_ERROR/cookieOptions() are small, local copies in auth.pg.service.js
// (kept out of mongoose's require chain deliberately - see that file's own header comment).
// This check (not the pilot itself) is where the two are confirmed to agree, for every value
// that matters to the browser - no PostgreSQL needed, so it always runs, never skipped.
test("auth.pg.service.js's cookie constants agree with auth.service.js's own, exactly", () => {
  const pgAuth = require("../services/auth.pg.service");
  const mongoAuth = require("../services/auth.service");
  assert.equal(pgAuth.COOKIE_NAME, mongoAuth.COOKIE_NAME);
  assert.equal(pgAuth.GENERIC_LOGIN_ERROR, mongoAuth.GENERIC_LOGIN_ERROR);
  assert.deepEqual(pgAuth.cookieOptions(), mongoAuth.cookieOptions());
});

test("\"users\" is deliberately NOT a known cutover route group - there is no way to accidentally activate this", () => {
  const { isPgAuthoritative, KNOWN_ROUTE_GROUPS } = require("../config/cutover");
  assert.ok(!KNOWN_ROUTE_GROUPS.includes("users"));
  assert.throws(() => {
    process.env.PG_CUTOVER_ROUTES = "users";
    isPgAuthoritative("users");
  }, /unknown route group/i);
  delete process.env.PG_CUTOVER_ROUTES;
});

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Phase 3, Group 2") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("Phase 3 Group 2: Users/Auth PostgreSQL service layer - login, sessions, setPassword, admin flows, invalidation", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const usersPg = require("../services/users.pg.service");
  const authPg = require("../services/auth.pg.service");
  const throttle = require("../services/loginThrottle");

  const lockClient = await lockAppSchema(getPool());
  throttle.clearAll(); // this project's own convention: never let one test's failed logins lock out another

  t.after(async () => {
    throttle.clearAll();
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  const STRONG_PASSWORD = "Snooker-cue-2026";
  let admin1;

  await t.test("1. login success: a real token, a session row, no password hash ever returned", async () => {
    admin1 = await usersPg.createUser({ name: "Admin One", username: "admin.one", role: "admin", password: STRONG_PASSWORD });
    const { token, user } = await authPg.login({ username: "ADMIN.ONE", password: STRONG_PASSWORD, ip: "127.0.0.1", userAgent: "test-agent" });
    assert.match(token, /^[A-Za-z0-9_-]+$/); // base64url, matches auth.service.js's own token shape
    assert.equal("passwordHash" in user, false, "login's own returned user object never includes the password hash");
    assert.equal(user.username, "admin.one"); // normalized, matching the login even though "ADMIN.ONE" was typed
    assert.ok(user.lastLoginAt);

    const sessionCount = await getPool().query("SELECT count(*)::int AS n FROM app.auth_sessions WHERE user_id = $1", [admin1.id]);
    assert.equal(sessionCount.rows[0].n, 1);
  });

  await t.test("2. invalid credentials: wrong password and an unknown username give the SAME generic error and status", async () => {
    await assert.rejects(
      authPg.login({ username: "admin.one", password: "wrong-password-123" }),
      (error) => { assert.equal(error.statusCode, 401); assert.equal(error.message, "Invalid username or password."); return true; }
    );
    await assert.rejects(
      authPg.login({ username: "no-such-user", password: STRONG_PASSWORD }),
      (error) => { assert.equal(error.statusCode, 401); assert.equal(error.message, "Invalid username or password."); return true; }
    );
  });

  await t.test("3. login throttle: 5 failed attempts for one username lock it out, independent of which database answers", async () => {
    throttle.clearAll(); // test 2 already left one failed attempt against "admin.one" - start this count from a clean 0
    for (let i = 0; i < 4; i++) {
      await assert.rejects(authPg.login({ username: "admin.one", password: "still-wrong" }));
    }
    await assert.rejects(
      authPg.login({ username: "admin.one", password: "still-wrong" }), // the 5th failure
      (error) => { assert.equal(error.statusCode, 401); return true; }
    );
    await assert.rejects(
      authPg.login({ username: "admin.one", password: STRONG_PASSWORD }), // now locked, even with the RIGHT password
      (error) => { assert.equal(error.statusCode, 429); assert.match(error.message, /Too many login attempts/); return true; }
    );
    throttle.clearAll(); // unlock for the remaining tests
  });

  let sessionA;
  await t.test("4. session resolution: a real token resolves to the real user; garbage and expired tokens resolve to null", async () => {
    const login = await authPg.login({ username: "admin.one", password: STRONG_PASSWORD });
    const resolved = await authPg.resolveSession(login.token);
    assert.equal(resolved.user.id, admin1.id);
    assert.equal(resolved.session._id, resolved.session.id, "the _id alias matches .id, for drop-in compatibility with req.authSession._id");
    sessionA = resolved.session;

    assert.equal(await authPg.resolveSession("not-a-real-token"), null);
    assert.equal(await authPg.resolveSession(""), null);
    assert.equal(await authPg.resolveSession(null), null);

    await getPool().query("UPDATE app.auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sessionA.id]);
    assert.equal(await authPg.resolveSession(login.token), null, "an expired session resolves to null, the real security check - not merely housekeeping");
  });

  await t.test("5. lastSeenAt is touched (at most once a minute) when a valid session is resolved", async () => {
    const login = await authPg.login({ username: "admin.one", password: STRONG_PASSWORD });
    await getPool().query("UPDATE app.auth_sessions SET last_seen_at = now() - interval '5 minutes' WHERE token_hash = (SELECT token_hash FROM app.auth_sessions ORDER BY created_at DESC LIMIT 1)");
    const before = await getPool().query("SELECT last_seen_at FROM app.auth_sessions ORDER BY created_at DESC LIMIT 1");
    await authPg.resolveSession(login.token);
    const after = await getPool().query("SELECT last_seen_at FROM app.auth_sessions ORDER BY created_at DESC LIMIT 1");
    assert.ok(new Date(after.rows[0].last_seen_at).getTime() > new Date(before.rows[0].last_seen_at).getTime());
    await authPg.logout(login.token);
  });

  await t.test("6. logout: the session is gone, and the same token no longer resolves to anyone", async () => {
    const login = await authPg.login({ username: "admin.one", password: STRONG_PASSWORD });
    await authPg.logout(login.token);
    assert.equal(await authPg.resolveSession(login.token), null);
  });

  let admin2;
  await t.test("7. setPassword: changes the hash, ends the user's OTHER sessions (not the current one), old password stops working", async () => {
    admin2 = await usersPg.createUser({ name: "Admin Two", username: "admin.two", role: "admin", password: STRONG_PASSWORD }, admin1);
    const loginOne = await authPg.login({ username: "admin.two", password: STRONG_PASSWORD });
    const loginTwo = await authPg.login({ username: "admin.two", password: STRONG_PASSWORD });
    const sessionTwo = await authPg.resolveSession(loginTwo.token);

    const NEW_PASSWORD = "Rack-em-up-2026";
    await usersPg.setPassword(admin2.id, NEW_PASSWORD, admin2, { currentSessionId: sessionTwo.session._id });

    assert.equal(await authPg.resolveSession(loginOne.token), null, "the other session was ended");
    assert.notEqual(await authPg.resolveSession(loginTwo.token), null, "the CURRENT session (the one making the change) was kept");
    await assert.rejects(authPg.login({ username: "admin.two", password: STRONG_PASSWORD }));
    const relogin = await authPg.login({ username: "admin.two", password: NEW_PASSWORD });
    assert.ok(relogin.token);
  });

  await t.test("8. deactivating a user (via updateUser) ends ALL of their sessions, not just the one that triggered it", async () => {
    const staff = await usersPg.createUser({ name: "Staff One", username: "staff.one", role: "staff", password: STRONG_PASSWORD }, admin1);
    const login = await authPg.login({ username: "staff.one", password: STRONG_PASSWORD });
    assert.notEqual(await authPg.resolveSession(login.token), null);

    await usersPg.updateUser(staff.id, { active: false }, admin1);
    assert.equal(await authPg.resolveSession(login.token), null, "deactivation logs the account out everywhere, immediately");

    await assert.rejects(
      authPg.login({ username: "staff.one", password: STRONG_PASSWORD }),
      (error) => { assert.equal(error.statusCode, 401); return true; } // inactive users get the SAME generic error as a wrong password
    );
  });

  await t.test("8a. self-protection works with the REAL PostgreSQL actor shape (.id, no ._id) - not just a hand-built MongoDB-style object", async () => {
    // admin1 here is exactly what usersPg.createUser() actually returned in test 1 - a plain
    // { id, name, username, ... } object, never reshaped to look like a Mongoose document. The
    // step 2.8 pilot's own original self-protection test (server/tests/postgresUsers.test.js)
    // happened to pass a hand-built `{ _id: admin1.id, ... }` actor, which accidentally matched
    // the OLD buggy check and never exercised this real shape - found while building Phase 3's
    // integration foundation, not assumed safe just because an older test was green.
    await assert.rejects(
      usersPg.updateUser(admin1.id, { active: false }, admin1),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can't deactivate your own account/); return true; }
    );
    await assert.rejects(
      usersPg.updateUser(admin1.id, { role: "staff" }, admin1),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can't remove your own admin role/); return true; }
    );
    // And the inverse: this real shape must NOT be mistaken for "self" when acting on someone
    // else entirely - a different, genuine user id.
    const other = await usersPg.createUser({ name: "Not Self", username: "not.self", role: "staff", password: STRONG_PASSWORD }, admin1);
    const changed = await usersPg.updateUser(other.id, { active: false }, admin1);
    assert.equal(changed.active, false, "acting on a genuinely different user is never blocked by self-protection");
  });

  await t.test("9. createFirstAdmin: refused once an active admin already exists (admin1, from test 1)", async () => {
    await assert.rejects(
      usersPg.createFirstAdmin({ name: "Someone Else", username: "someone.else", password: STRONG_PASSWORD }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already exists/); return true; }
    );
  });

  await t.test("10. resetAdminPassword: works for an active admin, refused for a non-admin, a deactivated admin, or a missing username; ends all sessions", async () => {
    const login = await authPg.login({ username: "admin.one", password: STRONG_PASSWORD });
    const NEW_ADMIN_PASSWORD = "Chalk-the-tip-2026";
    await usersPg.resetAdminPassword("admin.one", NEW_ADMIN_PASSWORD);

    assert.equal(await authPg.resolveSession(login.token), null, "every old login of this admin ended");
    await assert.rejects(authPg.login({ username: "admin.one", password: STRONG_PASSWORD }));
    const relogin = await authPg.login({ username: "admin.one", password: NEW_ADMIN_PASSWORD });
    assert.ok(relogin.token);

    await assert.rejects(
      usersPg.resetAdminPassword("staff.one", "Whatever-Password-123"), // not an admin
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
    await assert.rejects(
      usersPg.resetAdminPassword("no-such-user", "Whatever-Password-123"),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
  });

  await t.test("11. listUsers / listActiveAdmins: filters behave like users.service.js's own", async () => {
    const all = await usersPg.listUsers({});
    assert.ok(all.some((u) => u.username === "admin.one"));
    assert.ok(all.some((u) => u.username === "admin.two"));

    const admins = await usersPg.listUsers({ role: "admin" });
    assert.ok(admins.every((u) => u.role === "admin"));

    const inactiveOnly = await usersPg.listUsers({ active: false });
    assert.ok(inactiveOnly.some((u) => u.username === "staff.one"));
    assert.ok(!inactiveOnly.some((u) => u.active));

    const activeAdmins = await usersPg.listActiveAdmins();
    assert.ok(activeAdmins.every((a) => typeof a.username === "string"));
    assert.ok(activeAdmins.some((a) => a.username === "admin.one"));
  });

  await t.test("isolation: auth.pg.service.js never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/auth.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
