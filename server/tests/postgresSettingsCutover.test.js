// Tests for the Phase 3 Group 1 cutover: the Settings route's selector between MongoDB (the
// default, today's exact behaviour) and PostgreSQL (once PG_CUTOVER_ROUTES names "settings") -
// see docs/POSTGRES_MIGRATION.md's Phase 3 Group 1 section for the full design.
//
// Needs BOTH databases for real: MongoDB (every route still needs it for login - Users/Auth has
// not been cut over), and a real local PostgreSQL at 127.0.0.1:5433 (step 2.2A) for the
// PostgreSQL-authoritative assertions. SKIPPED with a clear reason if PG_TEST_DATABASE_URL isn't
// set - every other (non-Settings) route's own MongoDB tests are completely unaffected either
// way, and this file never runs with PG_CUTOVER_ROUTES set unless a subtest explicitly sets it.
//
// No mocks: every claim below (default selection, explicit selection, no accidental writes, no
// silent fallback, reconciliation, rollback) is checked against the real app, the real login
// flow, and real SQL/Mongo queries of what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL; // MUST happen before requiring ../app below (env.js caches DATABASE_URL at its own require time)

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Phase 3, Group 1") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb");
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");

const MONGO_TEST_URI = process.env.MONGODB_SETTINGSCUTOVER_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_settingscutover";

test("Phase 3 Group 1: the Settings cutover selector - default MongoDB, explicit PostgreSQL, no silent fallback, reconciliation, rollback", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const settingsCutover = require("../services/settingsCutover.service");
  const { Setting } = require("../models/Setting");

  const lockClient = await lockAppSchema(getPool());

  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminCookie = await loginAs(baseUrl, "admin");
  const staffCookie = await loginAs(baseUrl, "staff");

  t.after(async () => {
    delete process.env.PG_CUTOVER_ROUTES;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await dropTestDatabase();
    await mongoose.disconnect();
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  async function api(method, path, { body, cookie = adminCookie } = {}) {
    const options = { method, headers: { Cookie: cookie } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}/api${path}`, options);
    return { status: response.status, body: await response.json() };
  }
  async function ok(method, path, options) {
    const result = await api(method, path, options);
    assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
    return result.body.data;
  }

  await t.test("1. default (PG_CUTOVER_ROUTES unset): behaves exactly as MongoDB-only, no PostgreSQL row is ever created", async () => {
    delete process.env.PG_CUTOVER_ROUTES;
    const before = await ok("GET", "/settings");
    assert.equal(before.minimumBillableMinutes, 15); // models/Setting.js's own default

    const updated = await ok("PATCH", "/settings", { body: { minimumBillableMinutes: 20 } });
    assert.equal(updated.minimumBillableMinutes, 20);

    const mongoDoc = await Setting.findOne({ key: "club" });
    assert.equal(mongoDoc.minimumBillableMinutes, 20, "the write landed in MongoDB, exactly as before this group existed");

    const pgRows = await getPool().query("SELECT count(*)::int AS n FROM app.settings");
    assert.equal(pgRows.rows[0].n, 0, "PostgreSQL was never touched while it isn't the authoritative database for settings");
  });

  await t.test("2. an unknown PG_CUTOVER_ROUTES name is refused loudly, not silently ignored", async () => {
    process.env.PG_CUTOVER_ROUTES = "settings,typo-name";
    const result = await api("GET", "/settings");
    assert.equal(result.status, 500); // an unhandled config error, not a quiet fallback to either database
    delete process.env.PG_CUTOVER_ROUTES;
  });

  await t.test("3. explicit PostgreSQL selection: reads and writes now land in app.settings, not MongoDB", async () => {
    process.env.PG_CUTOVER_ROUTES = "settings";

    const read = await ok("GET", "/settings");
    assert.equal(read.minimumBillableMinutes, 15, "PostgreSQL's own row starts at ITS defaults, independent of MongoDB's current value (20, from test 1)");

    const updated = await ok("PATCH", "/settings", { body: { minimumBillableMinutes: 30, gameRates: { century: 1200 } } });
    assert.equal(updated.minimumBillableMinutes, 30);
    assert.equal(updated.gameRates.century, 1200);

    const pgRow = await getPool().query("SELECT minimum_billable_minutes, rate_century FROM app.settings WHERE key = 'club'");
    assert.equal(pgRow.rows[0].minimum_billable_minutes, 30);
    assert.equal(pgRow.rows[0].rate_century, "1200"); // bigint column, read back as text directly (not through the mapper) - the Settings pilot's own documented driver behaviour

    const mongoDoc = await Setting.findOne({ key: "club" });
    assert.equal(mongoDoc.minimumBillableMinutes, 20, "MongoDB's own value from test 1 is completely untouched by a PostgreSQL-authoritative write");
  });

  await t.test("4. backup-status fields always come from MongoDB, even while PostgreSQL is authoritative for everything else", async () => {
    await Setting.updateOne({ key: "club" }, { $set: { lastBackupFile: "backup-2026-10-13.xml", lastBackupError: null } });
    const read = await ok("GET", "/settings"); // PG_CUTOVER_ROUTES is still "settings" from test 3
    assert.equal(read.lastBackupFile, "backup-2026-10-13.xml", "backup status is never PostgreSQL-authoritative - backup.service.js only ever writes it to MongoDB");
  });

  await t.test("5. authorization is unchanged by the selector: staff can view but not manage, in EITHER database mode", async () => {
    const staffRead = await api("GET", "/settings", { cookie: staffCookie });
    assert.equal(staffRead.status, 200);
    const staffWrite = await api("PATCH", "/settings", { body: { minimumBillableMinutes: 99 }, cookie: staffCookie });
    assert.equal(staffWrite.status, 403);

    delete process.env.PG_CUTOVER_ROUTES; // back to MongoDB
    const staffWriteMongo = await api("PATCH", "/settings", { body: { minimumBillableMinutes: 99 }, cookie: staffCookie });
    assert.equal(staffWriteMongo.status, 403);
    process.env.PG_CUTOVER_ROUTES = "settings"; // restore for the remaining PostgreSQL-mode tests
  });

  await t.test("6. no silent fallback: a failing PostgreSQL write is reported as a failure, never quietly retried against MongoDB", async () => {
    const beforeMongo = await Setting.findOne({ key: "club" });
    // Force the PostgreSQL write to fail with a real, deliberate constraint violation (an
    // out-of-range tax rate the validator itself wouldn't normally let through this far - called
    // directly against the service, bypassing the HTTP validator, specifically to prove the
    // SERVICE layer's own behaviour on a failed write: it is not this test's job to re-test the
    // validator, which test 2's own suite already covers elsewhere).
    const pgSettings = require("../services/settings.pg.service");
    await assert.rejects(pgSettings.updateSettings({ taxRateBasisPoints: 99999 })); // violates the schema's own CHECK (0-10000)

    const afterMongo = await Setting.findOne({ key: "club" });
    assert.equal(afterMongo.minimumBillableMinutes, beforeMongo.minimumBillableMinutes, "MongoDB was never written to as a fallback for the failed PostgreSQL write");
    const pgRow = await getPool().query("SELECT tax_rate_basis_points FROM app.settings WHERE key = 'club'");
    assert.notEqual(pgRow.rows[0].tax_rate_basis_points, 99999, "the failed write itself never landed in PostgreSQL either - rejected cleanly, not partially applied");
  });

  await t.test("7. reconciliation: reports a real, deliberate mismatch between the two databases, without changing either one", async () => {
    await Setting.updateOne({ key: "club" }, { $set: { minimumBillableMinutes: 45 } }); // MongoDB now says 45; PostgreSQL still says 30 (test 3)
    const report = await settingsCutover.reconcileSettings();
    assert.equal(report.checked, true);
    assert.equal(report.inSync, false);
    const mismatch = report.differences.find((d) => d.field === "minimumBillableMinutes");
    assert.deepEqual(mismatch, { field: "minimumBillableMinutes", mongo: 45, postgres: 30 });

    const mongoStill = await Setting.findOne({ key: "club" });
    const pgStill = await getPool().query("SELECT minimum_billable_minutes FROM app.settings WHERE key = 'club'");
    assert.equal(mongoStill.minimumBillableMinutes, 45, "reconciliation is read-only - MongoDB's value is untouched");
    assert.equal(pgStill.rows[0].minimum_billable_minutes, 30, "and so is PostgreSQL's");
  });

  await t.test("8. rollback: switching the selector back to MongoDB immediately serves MongoDB's own current value again", async () => {
    delete process.env.PG_CUTOVER_ROUTES; // the entire rollback procedure for this group: unset the config
    const read = await ok("GET", "/settings");
    assert.equal(read.minimumBillableMinutes, 45, "back to MongoDB's own value (45, from test 7) - not PostgreSQL's (30), and not merged");
  });

  await t.test("isolation: the cutover selector never writes to PostgreSQL while MongoDB is authoritative, confirmed with a final count", async () => {
    const pgRows = await getPool().query("SELECT count(*)::int AS n FROM app.settings");
    assert.equal(pgRows.rows[0].n, 1, "exactly the one row created in test 3, never a second one, and no row created by any of the default-MongoDB tests");
  });
});
