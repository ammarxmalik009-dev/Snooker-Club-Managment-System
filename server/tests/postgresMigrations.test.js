// Tests for the PostgreSQL migration foundation (Phase 2, step 2.3 - see
// docs/POSTGRES_MIGRATION.md). Like server/tests/postgresConnection.test.js, this is the ONLY
// other file that touches PostgreSQL; every MongoDB test is completely unaffected.
//
// Requires PG_TEST_DATABASE_URL (server/tests/helpers/testDb.pg.js: a database whose name
// contains "test" as its own word). Without it, every test below is SKIPPED with a clear
// reason - a skip is not evidence the migrations actually run.
//
// Safety: this file only ever touches its own "app" schema inside the configured test
// database - never the whole database, never anything outside that one schema. It additionally
// insists the test database is the verified local one (127.0.0.1:5433, step 2.2A) before doing
// anything, as a belt-and-braces check on top of the name check.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl(); // null = not configured; never falls back to DATABASE_URL
if (TEST_URL) process.env.DATABASE_URL = TEST_URL; // read by server/config/env.js when required below

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.3: running the migration tests") to configure a local PostgreSQL test database';

// Belt-and-braces (on top of testDb.pg.js's own name check): refuse anything that isn't the
// verified local instance from step 2.2A, so a migration can never run against an unknown target.
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL migrations: connect, apply, track, re-run safely, status, constraints, rollback", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");

  // Several server/tests/postgres*.test.js files manage this SAME "app" schema, and node's test
  // runner runs test files in parallel by default (step 2.5 found this the hard way: without
  // this lock, two such files racing produce real deadlocks and "relation does not exist"
  // errors). This blocks until any other such file's own run has fully finished.
  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    // Clean up ONLY this schema, inside the configured test database - never the whole database.
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
    await unlockAppSchema(lockClient);
    await closePool();
  });

  // Isolation: start from a clean slate, but only by dropping OUR OWN schema (not the database).
  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");

  await t.test("1. the migration runner can connect to the intended test database", async () => {
    const result = await getPool().query("SELECT current_database() AS db");
    assert.equal(result.rows[0].db, "snooker_club_pro_test");
  });

  await t.test("2 & 3. a migration applies successfully and is recorded in the history table", async () => {
    const applied = await migrate.runMigrations();
    assert.deepEqual(applied, ["0001_initial_schema.sql"]);

    const recorded = await migrate.getAppliedMigrations();
    assert.deepEqual(recorded, ["0001_initial_schema.sql"]);
  });

  await t.test("4. re-running migrations does not apply the same migration twice", async () => {
    const appliedAgain = await migrate.runMigrations();
    assert.deepEqual(appliedAgain, [], "nothing pending - 0001 must not run a second time");

    const count = await getPool().query("SELECT count(*)::int AS n FROM app.schema_migrations WHERE id = '0001_initial_schema.sql'");
    assert.equal(count.rows[0].n, 1, "exactly one history row, not two");
  });

  await t.test("5. migration status accurately reports applied and pending migrations", async () => {
    const result = await migrate.status();
    assert.deepEqual(result.applied, ["0001_initial_schema.sql"]);
    assert.deepEqual(result.pending, []);
  });

  await t.test("6. the expected tables, foreign keys, unique constraints and indexes actually exist", async () => {
    const tables = await getPool().query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name"
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), [
      "auth_sessions", "bill_line_items", "bill_players", "bills", "bookings", "cafe_orders",
      "categories", "counters", "customers", "match_players", "match_teams", "matches",
      "payments", "players", "products", "schema_migrations", "sessions", "settings",
      "stock_movements", "tables", "users",
    ]);

    // Foreign keys: every table that should reference another one does (spot-checked across the
    // trickiest relationships, including the two pairs that needed a deferred ALTER TABLE).
    const fkTargets = async (table) => {
      const result = await getPool().query(
        `SELECT confrelid::regclass::text AS target FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'f' ORDER BY target`,
        [`app.${table}`]
      );
      return result.rows.map((r) => r.target);
    };
    assert.deepEqual(await fkTargets("sessions"), ["app.bookings", "app.tables", "app.users", "app.users"], "sessions -> bookings (the deferred one), tables, users x2");
    assert.deepEqual(await fkTargets("bookings"), ["app.customers", "app.sessions", "app.tables", "app.users", "app.users", "app.users"]);
    assert.deepEqual(await fkTargets("matches"), ["app.bills", "app.sessions", "app.tables", "app.users", "app.users", "app.users", "app.users"], "matches -> bills is the other deferred one");
    assert.deepEqual(await fkTargets("bills"), ["app.matches", "app.sessions", "app.tables", "app.users", "app.users"]);
    assert.deepEqual(await fkTargets("cafe_orders"), ["app.bills", "app.products", "app.sessions", "app.users", "app.users"]);
    assert.deepEqual(await fkTargets("payments"), ["app.bills", "app.users"]);

    // Unique / exclusion constraints and the partial indexes that matter most:
    const hasIndex = async (name) => {
      const result = await getPool().query("SELECT 1 FROM pg_indexes WHERE schemaname = 'app' AND indexname = $1", [name]);
      return result.rowCount === 1;
    };
    assert.ok(await hasIndex("users_username_key"));
    assert.ok(await hasIndex("sessions_one_open_per_table"));
    assert.ok(await hasIndex("bills_one_per_session_no_match"));
    assert.ok(await hasIndex("bills_one_per_session_and_match"));
    assert.ok(await hasIndex("bills_one_century_per_session"));

    const exclusion = await getPool().query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'app.bookings'::regclass AND contype = 'x'"
    );
    assert.deepEqual(exclusion.rows.map((r) => r.conname), ["bookings_no_overlap"]);
  });

  await t.test("7a. functional check: sessions_one_open_per_table actually blocks a second open session", async () => {
    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (501, 60000) RETURNING id");
    const tableId = table.rows[0].id;
    await getPool().query("INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start) VALUES ($1, 501, 60000)", [tableId]);
    await assert.rejects(
      getPool().query("INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start) VALUES ($1, 501, 60000)", [tableId]),
      /duplicate key value violates unique constraint "sessions_one_open_per_table"/
    );
  });

  await t.test("7b. functional check: bookings_no_overlap actually blocks an overlapping booking", async () => {
    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (502, 60000) RETURNING id");
    const tableId = table.rows[0].id;
    const customer = await getPool().query("INSERT INTO app.customers (name) VALUES ('Overlap Test') RETURNING id");
    const customerId = customer.rows[0].id;
    const bookingArgs = (start, end) => [customerId, tableId, "Overlap Test", 502, start, end];
    await getPool().query(
      "INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6)",
      bookingArgs("2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z")
    );
    await assert.rejects(
      getPool().query(
        "INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6)",
        bookingArgs("2026-11-01T10:30:00Z", "2026-11-01T11:30:00Z")
      ),
      /conflicting key value violates exclusion constraint "bookings_no_overlap"/
    );
  });

  await t.test("8. transaction rollback: a failing migration leaves nothing behind and is not recorded", async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "scp-pg-migration-fixture-"));
    try {
      // Filenames sort "good" before "bad" (0001 < 0002) - the runner applies in filename order,
      // so this proves an EARLIER migration's commit survives a LATER one's rollback.
      fs.writeFileSync(path.join(fixtureDir, "0001_fixture_good.sql"), "CREATE TABLE app.__test_rollback_ok (id int);\n");
      fs.writeFileSync(path.join(fixtureDir, "0002_fixture_bad.sql"), "CREATE TABLE app.__test_rollback_bad (id int);\nTHIS IS NOT VALID SQL;\n");

      await assert.rejects(migrate.runMigrations(fixtureDir));

      // The good one (its own transaction) committed; the bad one's transaction rolled back -
      // its CREATE TABLE never happened, and it was never recorded as "applied".
      const goodExists = await getPool().query("SELECT to_regclass('app.__test_rollback_ok') AS reg");
      assert.ok(goodExists.rows[0].reg, "the migration before the failing one must still have committed");
      const badExists = await getPool().query("SELECT to_regclass('app.__test_rollback_bad') AS reg");
      assert.equal(badExists.rows[0].reg, null, "the failing migration's CREATE TABLE must have been rolled back");

      const recorded = await getPool().query("SELECT id FROM app.schema_migrations WHERE id LIKE '%fixture%' ORDER BY id");
      assert.deepEqual(recorded.rows.map((r) => r.id), ["0001_fixture_good.sql"], "only the one that actually succeeded is recorded");
    } finally {
      // Clean up just these two test-only rows/table - nothing from the real 0001 migration.
      await getPool().query("DROP TABLE IF EXISTS app.__test_rollback_ok");
      await getPool().query("DELETE FROM app.schema_migrations WHERE id LIKE '%fixture%'");
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
