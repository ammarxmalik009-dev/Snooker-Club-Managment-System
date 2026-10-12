// PostgreSQL connection smoke test (Phase 2, step 2.2 - see docs/POSTGRES_MIGRATION.md). This is
// the ONLY test file in the project that touches PostgreSQL. Every other test still runs against
// MongoDB and is completely unaffected by whether PostgreSQL is installed or configured at all.
//
// Requires PG_TEST_DATABASE_URL: a real, throw-away PostgreSQL database whose name contains
// "test" as its own word (server/tests/helpers/testDb.pg.js - a stricter rule than the MongoDB
// test helper's). Without it, the two connecting tests below are SKIPPED with a clear reason.
// A skip is NOT evidence that PostgreSQL connectivity works - only that it was not checked here.
//
// These tests are read-only: one SELECT 1, and one transaction that is deliberately rolled back.
// Nothing is created, nothing is altered, and no other database is ever touched.
//
// Each test FILE in this project's `node --test` run gets its own process (confirmed separately),
// so setting DATABASE_URL here, before requiring anything that reads it, cannot affect any other
// test file - including the many that run against the real MongoDB test databases.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { getPgTestDatabaseUrl } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl(); // null = not configured; never falls back to DATABASE_URL
if (TEST_URL) process.env.DATABASE_URL = TEST_URL; // read by server/config/env.js when required below

const SKIP_REASON = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.2: running the smoke test") to configure a local PostgreSQL test database';

test("PostgreSQL: connects, runs SELECT 1, closes the pool cleanly", { skip: SKIP_REASON }, async () => {
  const { query, closePool } = require("../config/db.pg");
  try {
    const result = await query("SELECT 1 AS answer");
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].answer, 1);
  } finally {
    await closePool(); // explicit - nothing closes the pool on its own
  }
});

test("PostgreSQL: a transaction commits on success, and rolls back on an error", { skip: SKIP_REASON }, async () => {
  const { withTransaction, closePool } = require("../config/db.pg");
  try {
    const committed = await withTransaction((client) => client.query("SELECT 2 AS answer").then((r) => r.rows[0].answer));
    assert.equal(committed, 2);

    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("SELECT 1"); // the transaction did start before failing
        throw new Error("deliberate failure to test rollback");
      }),
      /deliberate failure to test rollback/,
      "withTransaction must re-throw the ORIGINAL error, not swallow it or replace it with a rollback error"
    );
  } finally {
    await closePool();
  }
});

// This check needs no PostgreSQL server at all - it only proves db.pg.js's own validation, so it
// always runs. A fresh subprocess (not require-cache tricks) gets a clean server/config/env.js
// with DATABASE_URL genuinely unset - the same pattern server/tests/helpers/envSetting.js uses.
test("db.pg.js: a clear error when DATABASE_URL is missing - not a confusing low-level one from pg", () => {
  const dbPgFile = path.join(__dirname, "..", "config", "db.pg.js");
  const script = `require(${JSON.stringify(dbPgFile)}).query("SELECT 1").then(
    () => { console.log("NO ERROR THROWN"); },
    (error) => { console.log(error.message); }
  );`;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, DATABASE_URL: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /DATABASE_URL is not set/);
});
