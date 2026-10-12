// Test helper for PostgreSQL smoke tests (Phase 2, step 2.2) - a separate, STRICTER rule from
// server/tests/helpers/testDb.js (MongoDB). That one accepts "test" ANYWHERE in the name, so a
// database literally named "snooker_club_pro_latest" would wrongly pass it ("latest" contains the
// substring "test"). This helper requires "test" as its OWN WORD, splitting the name on every
// run of non-alphanumeric characters - which includes "_", the separator this project's own
// database names use (step 2.2A found this the hard way: a plain \b-based regex treats "_" as
// part of the word, so it would wrongly REFUSE "snooker_club_pro_test" too): "test", "club_test"
// and "test_club" pass; "latest", "attest" and "mytest" (no separator at all) do not.
//
// This module makes no queries and performs no destructive action itself. There is no drop/reset
// function here on purpose - nothing in Phase 2 needs one yet, and the smoke test only reads.

// True if "test" is one of the name's own words, splitting on any run of non-alphanumeric
// characters (so "_", "-", "." etc. all count as separators, the same as "/" and ":" already do
// by virtue of not being letters/digits).
function hasTestWord(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).includes("test");
}

// The database name from a postgres:// connection string's path - never the user name or password.
function databaseNameFrom(connectionString) {
  try {
    return new URL(connectionString).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

// Throws unless the connection string's OWN database name contains "test" as a separate word.
// The error never includes the connection string itself (which may hold a password).
function assertTestDatabaseUrl(connectionString) {
  const name = databaseNameFrom(connectionString);
  if (!name || !hasTestWord(name)) {
    throw new Error(
      `Refusing to use database "${name || "(unknown)"}" for a PostgreSQL test: its name must ` +
        'contain "test" as its own word (e.g. "snooker_club_pro_test"). Nothing was connected to or changed.'
    );
  }
  return name;
}

// PG_TEST_DATABASE_URL: a connection string for an explicitly configured, throw-away PostgreSQL
// test database - deliberately a DIFFERENT variable from DATABASE_URL (the app's own, for Phase
// 3+). A test must never be able to run just because the real DATABASE_URL happens to be set.
// Returns null (never DATABASE_URL, never a guessed default) when it isn't configured - callers
// must skip the test, not invent a value or fall back to anything else.
function getPgTestDatabaseUrl() {
  const url = process.env.PG_TEST_DATABASE_URL;
  if (!url) return null;
  assertTestDatabaseUrl(url); // fail loudly and clearly now, not from deep inside a test
  return url;
}

// A fixed, arbitrary advisory-lock id, shared only by this project's own tests. Several
// server/tests/postgres*.test.js files each manage the SAME "app" schema (drop it, run the real
// migrations into it, test, drop it again) - and node's test runner runs test FILES in parallel
// by default (confirmed directly: without this lock, two such files running at once produce
// real deadlocks and "relation does not exist" errors, step 2.5). A PostgreSQL advisory lock
// serializes that: whichever test file calls lockAppSchema() first finishes its entire run
// (including its own cleanup) before the next one's lockAppSchema() call returns - verified
// directly with two real concurrent processes, not assumed. It has no effect on anything else
// (not on MongoDB, not on the schema's actual content) - it is purely a "one at a time" gate.
const APP_SCHEMA_LOCK_ID = 583742991;

// pg_advisory_lock/unlock are SESSION-scoped: they only work called on the exact same physical
// connection. A plain pool.query() for each call does NOT guarantee that (pg.Pool hands out
// whichever client is free) - confirmed the hard way: an early version of this using
// pool.query() for both calls let two test files corrupt each other's "app" schema and even
// produced a genuine PostgreSQL deadlock (code 40P01) between two of the pool's own connections.
// The fix: hold ONE dedicated client for the lock's entire lifetime; ordinary work can still use
// the pool normally (any connection) in between - only the lock/unlock pair must match sessions.
async function lockAppSchema(pool) {
  const client = await pool.connect();
  await client.query("SELECT pg_advisory_lock($1)", [APP_SCHEMA_LOCK_ID]);
  return client;
}

async function unlockAppSchema(client) {
  await client.query("SELECT pg_advisory_unlock($1)", [APP_SCHEMA_LOCK_ID]);
  client.release();
}

module.exports = { assertTestDatabaseUrl, getPgTestDatabaseUrl, databaseNameFrom, hasTestWord, lockAppSchema, unlockAppSchema };
