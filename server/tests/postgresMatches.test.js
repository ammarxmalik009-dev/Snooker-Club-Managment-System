// Tests for the Matches PostgreSQL pilot (Phase 2, step 2.14 - see docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real matches.service.js ones, is completely
// unaffected.
//
// No mocks: every constraint/concurrency/rollback claim below is checked by running real SQL
// against the real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.14") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Matches pilot: start/update/complete/cancel, player/team rules, the real session-lock guarantee", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const matchesPg = require("../services/matches.pg.service");
  const sessionsPg = require("../services/sessions.pg.service");
  const playersPg = require("../services/players.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  async function freshTable(tableNumber) {
    const result = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES ($1, 60000) RETURNING id", [tableNumber]);
    return result.rows[0].id;
  }

  let sessionA;

  await t.test("1. start a match (Century, 2 walk-ins) on an open session: numbering, player seats", async () => {
    const tableId = await freshTable(801);
    sessionA = await sessionsPg.startSession({ tableId });
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Walk-in A" }, { name: "Walk-in B" }] });
    assert.match(match.id, /^[0-9a-f-]{36}$/);
    assert.equal(match.number, 1);
    assert.equal(match.status, "in_progress");
    assert.equal(match.session, sessionA.id);
    assert.equal(match.tableNumber, 801);
    assert.equal(match.players.length, 2);
    assert.deepEqual(match.players.map((p) => p.seat), [1, 2]);
    assert.deepEqual(match.players.map((p) => p.name), ["Walk-in A", "Walk-in B"]);
    assert.equal(match.teams.length, 0);

    const reread = await matchesPg.getMatchById(match.id);
    assert.deepEqual(reread, match);
  });

  await t.test("2. a second match on the same session gets the next number (the atomic per-session counter)", async () => {
    const second = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "frame", players: [{ name: "Walk-in C" }, { name: "Walk-in D" }] });
    assert.equal(second.number, 2);
  });

  await t.test("3. a non-existent session gives 404; a closed session is refused and leaves no match behind", async () => {
    await assert.rejects(
      matchesPg.startMatch({ sessionId: "00000000-0000-0000-0000-000000000000", gameMode: "century", players: [{ name: "A" }, { name: "B" }] }),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );

    // Built directly with SQL, not sessionsPg.startSession()+endSession() back-to-back: a real,
    // pre-existing timing issue was found this way during this step's own repeated test runs -
    // endSession() computes ended_at with JS's own clock (new Date()) while started_at comes from
    // PostgreSQL's now() at the session's INSERT (transaction-start time, not statement time) -
    // calling them with near-zero delay can occasionally violate the sessions_check CHECK
    // constraint (ended_at >= started_at) by a few milliseconds. That is a Sessions pilot (step
    // 2.12) issue, already committed before this step and out of this step's scope to fix (see
    // docs/POSTGRES_MIGRATION.md's own remaining-risks note on it) - this fixture sidesteps it
    // entirely rather than exercising it, since what THIS test needs is simply "a closed session",
    // not a real start-then-end round trip.
    const closedTableId = await freshTable(802);
    const closedSession = await getPool().query(
      `INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start, is_open, status, ended_at)
       VALUES ($1, 802, 60000, false, 'completed', now()) RETURNING id`,
      [closedTableId]
    );
    await assert.rejects(
      matchesPg.startMatch({ sessionId: closedSession.rows[0].id, gameMode: "century", players: [{ name: "A" }, { name: "B" }] }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /has ended/); return true; }
    );
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.matches WHERE session_id = $1", [closedSession.rows[0].id]);
    assert.equal(count.rows[0].n, 0, "the refused attempt left no match behind on the closed session");
  });

  await t.test("4. an unknown game mode is refused", async () => {
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "darts", players: [{ name: "A" }, { name: "B" }] }),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
  });

  await t.test("5. player-count rules from the game-mode registry are enforced (Snooker Point needs exactly 3)", async () => {
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "snooker_point", players: [{ name: "A" }, { name: "B" }] }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /needs exactly 3 players/); return true; }
    );
  });

  await t.test("6. duplicate players are refused: the same registered player twice, or two walk-ins with the same name", async () => {
    const player = await playersPg.createPlayer({ name: "Duplicate Dawood" });
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ playerId: player.id }, { playerId: player.id }] }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /already in this match/); return true; }
    );
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Same Name" }, { name: "same   name" }] }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /different name/); return true; }
    );
  });

  await t.test("7. a registered player must exist and be active", async () => {
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ playerId: "00000000-0000-0000-0000-000000000000" }, { name: "Walk-in" }] }),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
    const inactivePlayer = await playersPg.createPlayer({ name: "Inactive Imran" });
    await playersPg.setActive(inactivePlayer.id, false);
    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ playerId: inactivePlayer.id }, { name: "Walk-in" }] }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /deactivated/); return true; }
    );
  });

  await t.test("8. a registered player's CURRENT name is copied, not a typed one", async () => {
    const player = await playersPg.createPlayer({ name: "Registered Rida" });
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ playerId: player.id }, { name: "Walk-in" }] });
    const registeredEntry = match.players.find((p) => p.player === player.id);
    assert.equal(registeredEntry.name, "Registered Rida");
  });

  await t.test("9. team mode (4 Players): exactly 2+2 seats, team assignment enforced", async () => {
    const fourPlayer = await matchesPg.startMatch({
      sessionId: sessionA.id, gameMode: "four_player",
      players: [{ name: "P1", team: 1 }, { name: "P2", team: 1 }, { name: "P3", team: 2 }, { name: "P4", team: 2 }],
    });
    assert.equal(fourPlayer.teams.length, 2);
    assert.deepEqual(fourPlayer.teams.map((t) => t.number), [1, 2]);
    assert.deepEqual(fourPlayer.teams[0].seats, [1, 2]);
    assert.deepEqual(fourPlayer.teams[1].seats, [3, 4]);
    assert.deepEqual(fourPlayer.players.map((p) => p.team), [1, 1, 2, 2]);

    await assert.rejects(
      matchesPg.startMatch({
        sessionId: sessionA.id, gameMode: "four_player",
        players: [{ name: "P1", team: 1 }, { name: "P2", team: 1 }, { name: "P3", team: 1 }, { name: "P4", team: 2 }],
      }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /exactly 2 players/); return true; }
    );

    await assert.rejects(
      matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "A", team: 1 }, { name: "B" }] }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /Teams are only used for 4 Players/); return true; }
    );
  });

  await t.test("10. update: editing players while in_progress works; refused once completed", async () => {
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Edit Me" }, { name: "Edit You" }] });
    const updated = await matchesPg.updateMatch(match.id, { players: [{ name: "Edited A" }, { name: "Edited B" }, { name: "Edited C" }] });
    assert.equal(updated.players.length, 3);
    assert.deepEqual(updated.players.map((p) => p.name), ["Edited A", "Edited B", "Edited C"]);

    await matchesPg.completeMatch(match.id, { winnerSeat: 1 });
    await assert.rejects(
      matchesPg.updateMatch(match.id, { players: [{ name: "Too Late A" }, { name: "Too Late B" }] }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /completed/); return true; }
    );
  });

  await t.test("11. complete: winner/loser results are set correctly; can't be completed twice", async () => {
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "frame", players: [{ name: "Winner Wali" }, { name: "Loser Lala" }] });
    const completed = await matchesPg.completeMatch(match.id, { winnerSeat: 1 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.winnerSeat, 1);
    assert.ok(completed.endedAt);
    assert.ok(completed.resultRecordedAt);
    const winner = completed.players.find((p) => p.seat === 1);
    const loser = completed.players.find((p) => p.seat === 2);
    assert.equal(winner.result, "winner");
    assert.equal(loser.result, "loser");

    await assert.rejects(
      matchesPg.completeMatch(match.id, { winnerSeat: 2 }),
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
  });

  await t.test("12. complete a team match: the whole winning team is marked winner, the whole losing team loser", async () => {
    const match = await matchesPg.startMatch({
      sessionId: sessionA.id, gameMode: "four_player",
      players: [{ name: "T1A", team: 1 }, { name: "T1B", team: 1 }, { name: "T2A", team: 2 }, { name: "T2B", team: 2 }],
    });
    const completed = await matchesPg.completeMatch(match.id, { winningTeam: 2 });
    assert.equal(completed.winningTeam, 2);
    assert.equal(completed.losingTeam, 1);
    for (const player of completed.players) {
      assert.equal(player.result, player.team === 2 ? "winner" : "loser");
    }
    // Choosing a winnerSeat for a team mode is refused with a specific message.
    const another = await matchesPg.startMatch({
      sessionId: sessionA.id, gameMode: "four_player",
      players: [{ name: "X1", team: 1 }, { name: "X2", team: 1 }, { name: "X3", team: 2 }, { name: "X4", team: 2 }],
    });
    await assert.rejects(
      matchesPg.completeMatch(another.id, { winnerSeat: 1 }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /choose the winning team/); return true; }
    );
  });

  await t.test("13. cancel: sets status/reason; can't be cancelled twice, and can't be cancelled once completed", async () => {
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Cancel A" }, { name: "Cancel B" }] });
    const cancelled = await matchesPg.cancelMatch(match.id, { reason: "table needed" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "table needed");
    assert.ok(cancelled.cancelledAt);

    await assert.rejects(matchesPg.cancelMatch(match.id), (error) => { assert.equal(error.statusCode, 409); return true; });

    const completedMatch = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Done A" }, { name: "Done B" }] });
    await matchesPg.completeMatch(completedMatch.id, { winnerSeat: 1 });
    await assert.rejects(matchesPg.cancelMatch(completedMatch.id), (error) => { assert.equal(error.statusCode, 409); return true; });
  });

  await t.test("14. listMatchesForSession returns every match on the session, ordered by number", async () => {
    const list = await matchesPg.listMatchesForSession(sessionA.id);
    assert.ok(list.length >= 2);
    const numbers = list.map((m) => m.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    await assert.rejects(matchesPg.listMatchesForSession("00000000-0000-0000-0000-000000000000"), (error) => { assert.equal(error.statusCode, 404); return true; });
  });

  await t.test("15. the real transaction: deleting players and re-inserting is all-or-nothing on failure", async () => {
    const match = await matchesPg.startMatch({ sessionId: sessionA.id, gameMode: "century", players: [{ name: "Rollback A" }, { name: "Rollback B" }] });
    const before = await getPool().query("SELECT name FROM app.match_players WHERE match_id = $1 ORDER BY seat", [match.id]);
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("DELETE FROM app.match_players WHERE match_id = $1", [match.id]);
        await client.query("INSERT INTO app.match_players (match_id, position, name, seat) VALUES ($1, 0, 'dup seat', 1)", [match.id]);
        await client.query("INSERT INTO app.match_players (match_id, position, name, seat) VALUES ($1, 1, 'dup seat again', 1)", [match.id]); // duplicate seat -> forces a rollback
      })
    );
    const after = await getPool().query("SELECT name FROM app.match_players WHERE match_id = $1 ORDER BY seat", [match.id]);
    assert.deepEqual(after.rows.map((r) => r.name), before.rows.map((r) => r.name), "the DELETE inside the failed transaction was rolled back, not partially applied");
  });

  await t.test("16. real concurrency: starting a match and ending the same session at the same moment - the database decides who wins, not application code", async () => {
    const raceTableId = await freshTable(803);
    const raceSession = await sessionsPg.startSession({ tableId: raceTableId });
    const [startResult, endResult] = await Promise.allSettled([
      matchesPg.startMatch({ sessionId: raceSession.id, gameMode: "century", players: [{ name: "Race A" }, { name: "Race B" }] }),
      sessionsPg.endSession(raceSession.id),
    ]);
    // Whichever order the database's row lock actually serialized them in, the end result must be
    // CONSISTENT: either the match exists and the session ended after it, or starting the match
    // was refused because the session had already closed - never a match silently orphaned on a
    // session that appears closed without ever having allowed it.
    const matchCount = await getPool().query("SELECT count(*)::int AS n FROM app.matches WHERE session_id = $1", [raceSession.id]);
    if (startResult.status === "fulfilled") {
      assert.equal(matchCount.rows[0].n, 1, "the match that was allowed to start is actually there");
    } else {
      assert.equal(startResult.reason.statusCode, 409);
      assert.equal(matchCount.rows[0].n, 0, "the refused start left no match behind");
    }
    assert.equal(endResult.status, "fulfilled", "ending the session itself always succeeds regardless of the match race");
  });

  await t.test("isolation: the Matches pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/matches.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
