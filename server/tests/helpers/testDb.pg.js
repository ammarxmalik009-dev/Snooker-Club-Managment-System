// Test helper for PostgreSQL smoke tests (Phase 2, step 2.2) - a separate, STRICTER rule from
// server/tests/helpers/testDb.js (MongoDB). That one accepts "test" ANYWHERE in the name, so a
// database literally named "snooker_club_pro_latest" would wrongly pass it ("latest" contains the
// substring "test"). This helper requires "test" as its OWN WORD (bounded by the start/end of the
// name or a non-letter/digit/underscore character): "test", "club_test" and "test_club" pass;
// "latest" and "attest" do not.
//
// This module makes no queries and performs no destructive action itself. There is no drop/reset
// function here on purpose - nothing in Phase 2 needs one yet, and the smoke test only reads.

const TEST_WORD = /\btest\b/i;

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
  if (!name || !TEST_WORD.test(name)) {
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

module.exports = { assertTestDatabaseUrl, getPgTestDatabaseUrl, databaseNameFrom };
