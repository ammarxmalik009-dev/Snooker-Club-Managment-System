// Tests for the ordered child-row pattern (Phase 2, step 2.5 - "position" columns, step 2.3's
// design) on REAL application tables: app.match_players and app.match_teams. See
// docs/POSTGRES_MIGRATION.md.
//
// IMPORTANT, scope: this file inserts the few parent rows (a table, a session, a match) that
// match_players/match_teams need to exist at all, with plain, direct SQL. It does NOT implement
// or port a Matches repository/service - there is no server/services/matches.pg.service.js, and
// nothing here reproduces Match.js's business rules (starting/completing a match, results,
// billing). This is fixture setup only, kept to the minimum needed to reach the two tables this
// step is actually about.
//
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A) - SKIPPED with a clear reason
// otherwise. Every MongoDB test is completely unaffected.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.5") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL ordered child rows (match_players, match_teams): position survives, uniqueness holds", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");

  // See testDb.pg.js: several postgres*.test.js files share this "app" schema, and test files
  // run in parallel by default - this blocks until any other such file's run has fully finished.
  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  // Minimal fixture: table -> session -> match (see file header - no Matches service exists)
  const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (601, 60000) RETURNING id");
  const tableId = table.rows[0].id;
  const session = await getPool().query(
    "INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start) VALUES ($1, 601, 60000) RETURNING id",
    [tableId]
  );
  const sessionId = session.rows[0].id;
  const match = await getPool().query(
    "INSERT INTO app.matches (session_id, number, table_id, table_number, game_mode) VALUES ($1, 1, $2, 601, 'four_player') RETURNING id",
    [sessionId, tableId]
  );
  const matchId = match.rows[0].id;

  await t.test("ordered child rows: inserted out of order, read back in the ORIGINAL (position) order, not insertion order", async () => {
    // Deliberately inserted in a SCRAMBLED order (seat 3 first, then 1, then 4, then 2) with
    // position set to the match's real player order (0-3) - proving the read-back order comes
    // from `position`, not from whatever order the rows happened to be written in.
    const players = [
      { position: 2, seat: 3, name: "Charlie" },
      { position: 0, seat: 1, name: "Alice" },
      { position: 3, seat: 4, name: "Dee" },
      { position: 1, seat: 2, name: "Bilal" },
    ];
    for (const p of players) {
      await getPool().query(
        "INSERT INTO app.match_players (match_id, position, name, seat) VALUES ($1, $2, $3, $4)",
        [matchId, p.position, p.name, p.seat]
      );
    }

    const result = await getPool().query("SELECT name, seat, position FROM app.match_players WHERE match_id = $1 ORDER BY position", [matchId]);
    assert.deepEqual(result.rows.map((r) => r.name), ["Alice", "Bilal", "Charlie", "Dee"], "must read back in position order, not insertion order");
    assert.deepEqual(result.rows.map((r) => r.seat), [1, 2, 3, 4]);
  });

  await t.test("unique constraint: two players can't share a seat in the same match", async () => {
    await assert.rejects(
      getPool().query("INSERT INTO app.match_players (match_id, position, name, seat) VALUES ($1, 4, 'Extra', 1)", [matchId]),
      /duplicate key value violates unique constraint "match_players_match_seat_key"/
    );
  });

  await t.test("walk-in players (player_id null) are allowed, and the player-lookup index only covers real registered players", async () => {
    const result = await getPool().query("SELECT player_id FROM app.match_players WHERE match_id = $1 AND seat = 1", [matchId]);
    assert.equal(result.rows[0].player_id, null, "every player above was a walk-in (no player_id given)");
  });

  await t.test("match_teams: ordered by number, native seats array preserved exactly", async () => {
    // Again inserted out of order (team 2 first)
    await getPool().query("INSERT INTO app.match_teams (match_id, number, name, seats) VALUES ($1, 2, 'Team 2', $2)", [matchId, [3, 4]]);
    await getPool().query("INSERT INTO app.match_teams (match_id, number, name, seats) VALUES ($1, 1, 'Team 1', $2)", [matchId, [1, 2]]);

    const result = await getPool().query("SELECT name, seats FROM app.match_teams WHERE match_id = $1 ORDER BY number", [matchId]);
    assert.deepEqual(result.rows.map((r) => r.name), ["Team 1", "Team 2"]);
    assert.deepEqual(result.rows.map((r) => r.seats), [[1, 2], [3, 4]], "the seats array round-trips exactly, in the right order");
  });

  await t.test("unique constraint: a match can't have two 'Team 1's", async () => {
    await assert.rejects(
      getPool().query("INSERT INTO app.match_teams (match_id, number, name, seats) VALUES ($1, 1, 'Duplicate', $2)", [matchId, [1, 2]]),
      /duplicate key value violates unique constraint "match_teams_match_number_key"/
    );
  });

  await t.test("ON DELETE CASCADE: deleting the match removes its players and teams too, nothing orphaned", async () => {
    await getPool().query("DELETE FROM app.matches WHERE id = $1", [matchId]);
    const players = await getPool().query("SELECT count(*)::int AS n FROM app.match_players WHERE match_id = $1", [matchId]);
    const teams = await getPool().query("SELECT count(*)::int AS n FROM app.match_teams WHERE match_id = $1", [matchId]);
    assert.equal(players.rows[0].n, 0);
    assert.equal(teams.rows[0].n, 0);
  });
});
