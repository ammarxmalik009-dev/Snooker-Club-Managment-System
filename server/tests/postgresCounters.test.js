// Tests for the Counters PostgreSQL pilot (Phase 2, step 2.16 - see
// docs/POSTGRES_MIGRATION.md). Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A);
// SKIPPED with a clear reason otherwise. Every MongoDB test, including models/Counter.js's own
// real callers (bills.service.js, matches.service.js), is completely unaffected.
//
// No mocks: every atomicity/concurrency/rollback claim below is checked by running real SQL
// against the real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.16") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Counters pilot: atomic upsert-and-increment, real concurrency, both transaction modes", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const countersPg = require("../services/counters.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  await t.test("1. a brand-new counter's first call returns 1, as a plain JS number (not a string, not a BigInt)", async () => {
    const first = await countersPg.nextSequence("bill-2026-10-13");
    assert.equal(first, 1);
    assert.equal(typeof first, "number");
  });

  await t.test("2. repeated calls for the same name return consecutive values with no gaps", async () => {
    const second = await countersPg.nextSequence("bill-2026-10-13");
    const third = await countersPg.nextSequence("bill-2026-10-13");
    assert.equal(second, 2);
    assert.equal(third, 3);
  });

  await t.test("3. different counter names are completely independent of each other", async () => {
    const matchCounter = await countersPg.nextSequence("match-some-session-id");
    assert.equal(matchCounter, 1, "a different name starts at 1 regardless of how far 'bill-2026-10-13' has already advanced");
    const billAgain = await countersPg.nextSequence("bill-2026-10-13");
    assert.equal(billAgain, 4, "and advancing the other name didn't touch this one's own sequence either");
  });

  await t.test("4. real concurrency: 20 genuinely simultaneous calls for the identical name produce exactly the unique values 1..20, never a duplicate", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => countersPg.nextSequence("race-counter")));
    const sorted = [...results].sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: 20 }, (_, i) => i + 1), "the database's own atomic upsert-and-increment decided this, not application code");
    assert.equal(new Set(results).size, 20, "no duplicate value was ever handed out");
  });

  await t.test("5. transaction-scoped: the increment rolls back together with a later failure in the SAME transaction", async () => {
    const before = await getPool().query("SELECT seq FROM app.counters WHERE id = 'txn-counter'");
    assert.equal(before.rows.length, 0, "this counter doesn't exist yet");

    await assert.rejects(
      withTransaction(async (client) => {
        const value = await countersPg.nextSequence("txn-counter", client);
        assert.equal(value, 1);
        await client.query("INSERT INTO app.counters (id, seq) VALUES ('txn-counter', 999)"); // duplicate PK -> forces a rollback
      })
    );

    const after = await getPool().query("SELECT seq FROM app.counters WHERE id = 'txn-counter'");
    assert.equal(after.rows.length, 0, "the row the increment created was rolled back along with everything else in that transaction - never committed at all");
  });

  await t.test("6. standalone: a completed increment is NOT rolled back by a later, unrelated transaction's failure", async () => {
    const value = await countersPg.nextSequence("standalone-counter"); // no client -> commits immediately on its own
    assert.equal(value, 1);

    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("SELECT 1"); // an unrelated transaction
        throw new Error("something else entirely failed, nothing to do with the counter above");
      })
    );

    const stillThere = await getPool().query("SELECT seq FROM app.counters WHERE id = 'standalone-counter'");
    assert.equal(stillThere.rows[0].seq, "1", "the standalone increment from step 1 is still committed, untouched by the later, unrelated transaction's own failure");
    const next = await countersPg.nextSequence("standalone-counter");
    assert.equal(next, 2, "and the sequence continues from where the standalone call left it, not from 1 again");
  });

  await t.test("7. invalid names are rejected cleanly, before any SQL is run", async () => {
    await assert.rejects(countersPg.nextSequence(""), (error) => { assert.equal(error.statusCode, 400); return true; });
    await assert.rejects(countersPg.nextSequence("   "), (error) => { assert.equal(error.statusCode, 400); return true; });
    await assert.rejects(countersPg.nextSequence(null), (error) => { assert.equal(error.statusCode, 400); return true; });
    await assert.rejects(countersPg.nextSequence(undefined), (error) => { assert.equal(error.statusCode, 400); return true; });
    await assert.rejects(countersPg.nextSequence(42), (error) => { assert.equal(error.statusCode, 400); return true; });
    await assert.rejects(countersPg.nextSequence("x".repeat(201)), (error) => { assert.equal(error.statusCode, 400); return true; });
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.counters WHERE id = ''");
    assert.equal(count.rows[0].n, 0, "none of the refused calls created a row");
  });

  await t.test("8. an invalid transaction-scoped client argument is rejected immediately, not silently treated as standalone", async () => {
    await assert.rejects(
      countersPg.nextSequence("some-counter", { notAQueryMethod: true }),
      (error) => { assert.ok(error instanceof TypeError); return true; }
    );
    await assert.rejects(
      countersPg.nextSequence("some-counter", "not-even-an-object"),
      (error) => { assert.ok(error instanceof TypeError); return true; }
    );
  });

  await t.test("isolation: the Counters pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/counters.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
