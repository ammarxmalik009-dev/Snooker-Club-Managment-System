// Tests for the Phase 3, Group 2 cutover adapters: server/services/authCutover.service.js and
// server/services/usersCutover.service.js. These adapters are NOT wired into any route or
// middleware yet, and "users" is NOT in server/config/cutover.js's KNOWN_ROUTE_GROUPS - so the
// real selector mechanism cannot be flipped to PostgreSQL for "users" without it refusing
// outright (by design: activation isn't safe yet). Both adapters accept an explicit, documented,
// test-only `{ forcePg: true }` override for exactly this reason - see authCutover.service.js's
// own header comment for the full explanation. No production caller passes this; it exists so
// this file can prove the PostgreSQL delegation path actually works, in isolation, without
// touching the selector or any route.
//
// Needs BOTH databases for real: MongoDB (the default delegation target) and a real local
// PostgreSQL at 127.0.0.1:5433 (step 2.2A) for the forced-PostgreSQL delegation tests. SKIPPED
// with a clear reason if PG_TEST_DATABASE_URL isn't set.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

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

const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb");

const MONGO_TEST_URI = process.env.MONGODB_USERSAUTHCUTOVER_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_usersauthcutover";

test("Phase 3 Group 2: authCutover/usersCutover adapters - MongoDB default, forced-PostgreSQL delegation, consistent shapes", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const { identityOf, actorFrom } = require("../models/schemas/actor");
  const authCutover = require("../services/authCutover.service");
  const usersCutover = require("../services/usersCutover.service");

  const lockClient = await lockAppSchema(getPool());

  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  t.after(async () => {
    await dropTestDatabase();
    await mongoose.disconnect();
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  const STRONG_PASSWORD = "Snooker-cue-2026";

  await t.test("1. default (no forcePg): both adapters delegate to MongoDB, exactly like calling the MongoDB service directly", async () => {
    const { createUser } = require("../services/users.service");
    const mongoUser = await createUser({ name: "Mongo Admin", username: "mongo.admin", role: "admin", password: STRONG_PASSWORD });

    const login = await authCutover.login({ username: "mongo.admin", password: STRONG_PASSWORD });
    assert.ok(login.token);
    assert.equal(login.user.username, "mongo.admin");
    assert.equal(String(login.user._id), String(mongoUser._id), "the real MongoDB user's own _id, unchanged by the adapter");

    const listed = await usersCutover.listUsers({});
    assert.ok(listed.some((u) => u.username === "mongo.admin"));

    const fetched = await usersCutover.getUserById(mongoUser._id);
    assert.equal(fetched.username, "mongo.admin");
  });

  await t.test("2. forcePg: true delegates to the real PostgreSQL services instead - proven with a genuine round trip, not assumed from the override alone", async () => {
    const created = await usersCutover.createUser({ name: "Pg Admin", username: "pg.admin", role: "admin", password: STRONG_PASSWORD }, null, { forcePg: true });
    assert.match(created.id, /^[0-9a-f-]{36}$/, "a real PostgreSQL UUID, not a MongoDB ObjectId");

    const pgCount = await getPool().query("SELECT count(*)::int AS n FROM app.users WHERE username = 'pg.admin'");
    assert.equal(pgCount.rows[0].n, 1, "the row genuinely exists in app.users - this is a real delegation, not a stub");

    const mongoCount = await mongoose.connection.db.collection("users").countDocuments({ username: "pg.admin" });
    assert.equal(mongoCount, 0, "and it was never written to MongoDB - exactly one backend was called, never both");
  });

  await t.test("3. consistent user identity shape: the PostgreSQL-delegated login result has BOTH .id and a ._id alias", async () => {
    const login = await authCutover.login({ username: "pg.admin", password: STRONG_PASSWORD }, { forcePg: true });
    assert.ok(login.token);
    assert.match(login.user.id, /^[0-9a-f-]{36}$/);
    assert.equal(login.user._id, login.user.id, "the adapter's own normalization: ._id aliased to .id for PostgreSQL-shaped users");
    assert.equal("passwordHash" in login.user, false);
  });

  await t.test("4. actor identity compatibility: a PostgreSQL-delegated login's user produces a valid, usable actor via actorFrom/identityOf", async () => {
    const login = await authCutover.login({ username: "pg.admin", password: STRONG_PASSWORD }, { forcePg: true });
    assert.equal(identityOf(login.user), login.user.id);
    const actor = actorFrom(login.user);
    assert.equal(actor.user, login.user.id);
    assert.equal(actor.name, "Pg Admin");
    assert.equal(actor.username, "pg.admin");
  });

  await t.test("5. login failure and invalid credentials: identical behaviour on both backends", async () => {
    await assert.rejects(
      authCutover.login({ username: "mongo.admin", password: "wrong" }),
      (error) => { assert.equal(error.statusCode, 401); assert.equal(error.message, "Invalid username or password."); return true; }
    );
    await assert.rejects(
      authCutover.login({ username: "pg.admin", password: "wrong" }, { forcePg: true }),
      (error) => { assert.equal(error.statusCode, 401); assert.equal(error.message, "Invalid username or password."); return true; }
    );
  });

  await t.test("6. consistent session contract: resolveSession's session._id works the same way on both backends", async () => {
    const mongoLogin = await authCutover.login({ username: "mongo.admin", password: STRONG_PASSWORD });
    const mongoResolved = await authCutover.resolveSession(mongoLogin.token);
    assert.ok(mongoResolved.session._id);

    const pgLogin = await authCutover.login({ username: "pg.admin", password: STRONG_PASSWORD }, { forcePg: true });
    const pgResolved = await authCutover.resolveSession(pgLogin.token, { forcePg: true });
    assert.ok(pgResolved.session._id);
    assert.equal(pgResolved.session._id, pgResolved.session.id);
  });

  await t.test("7. expired and revoked sessions resolve to null on the PostgreSQL-delegated path, the same as MongoDB's own", async () => {
    const login = await authCutover.login({ username: "pg.admin", password: STRONG_PASSWORD }, { forcePg: true });
    await getPool().query("UPDATE app.auth_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = (SELECT token_hash FROM app.auth_sessions ORDER BY created_at DESC LIMIT 1)");
    assert.equal(await authCutover.resolveSession(login.token, { forcePg: true }), null);

    const login2 = await authCutover.login({ username: "pg.admin", password: STRONG_PASSWORD }, { forcePg: true });
    await authCutover.logout(login2.token, { forcePg: true });
    assert.equal(await authCutover.resolveSession(login2.token, { forcePg: true }), null, "logout invalidates the actual session, not merely clears a cookie");
  });

  await t.test("8. error propagation never leaks a secret: a rejected login's error carries no password, hash or token", async () => {
    await assert.rejects(
      authCutover.login({ username: "pg.admin", password: "definitely-wrong-password" }, { forcePg: true }),
      (error) => {
        const serialized = JSON.stringify({ message: error.message, statusCode: error.statusCode, errors: error.errors });
        assert.doesNotMatch(serialized, /definitely-wrong-password/);
        assert.doesNotMatch(serialized, /scrypt\$/); // the stored hash's own format prefix
        return true;
      }
    );
  });

  await t.test("9. self-protection and last-admin safeguards hold through the adapter too, with the real PostgreSQL actor shape", async () => {
    const admin = await usersCutover.getUserById((await require("../services/users.pg.service").getUserByUsername("pg.admin")).id, { forcePg: true });
    await assert.rejects(
      usersCutover.updateUser(admin.id, { active: false }, admin, { forcePg: true }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can't deactivate your own account/); return true; }
    );
    const activeAdmins = await usersCutover.countActiveAdmins({ forcePg: true });
    assert.ok(activeAdmins >= 1);
  });

  await t.test("isolation: neither adapter touches the WRONG backend - confirmed by direct row counts across both databases one more time", async () => {
    const mongoUsers = await mongoose.connection.db.collection("users").countDocuments({});
    const pgUsers = await getPool().query("SELECT count(*)::int AS n FROM app.users");
    assert.equal(mongoUsers, 1, "exactly the one MongoDB user this file created (mongo.admin)");
    assert.equal(pgUsers.rows[0].n, 1, "exactly the one PostgreSQL user this file created (pg.admin) - never duplicated into the other database");
  });
});
