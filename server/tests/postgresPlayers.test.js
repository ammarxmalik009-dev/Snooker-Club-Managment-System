// Tests for the Players PostgreSQL pilot (Phase 2, step 2.13 - see docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real players.service.js ones, is completely
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
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.13") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Players pilot: create/read/update/deactivate, duplicate-name rules, search, FK compatibility", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const playersPg = require("../services/players.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  let playerA;

  await t.test("1. create and retrieve a player - nameKey/phoneDigits are internal, not in the response", async () => {
    playerA = await playersPg.createPlayer({ name: "  Ali Khan  ", phone: "0300-1234567", notes: "left-handed" });
    assert.match(playerA.id, /^[0-9a-f-]{36}$/);
    assert.equal(playerA.name, "Ali Khan"); // trimmed
    assert.equal(playerA.isActive, true);
    assert.equal(playerA.deactivatedAt, null);
    assert.equal("nameKey" in playerA, false);
    assert.equal("phoneDigits" in playerA, false);

    const reread = await playersPg.getPlayerById(playerA.id);
    assert.deepEqual(reread, playerA);
  });

  await t.test("2. duplicate names are refused - case/space-insensitive, and the message differs for an inactive match", async () => {
    await assert.rejects(
      playersPg.createPlayer({ name: "  ALI   khan  " }), // same nameKey, different capitals/spacing
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already registered/); assert.doesNotMatch(error.message, /reactivate/); return true; }
    );
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.players WHERE name_key = 'ali khan'");
    assert.equal(count.rows[0].n, 1, "the refused duplicate left no second row behind");

    await playersPg.setActive(playerA.id, false);
    await assert.rejects(
      playersPg.createPlayer({ name: "Ali Khan" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /reactivate them instead/); return true; }
    );
    await playersPg.setActive(playerA.id, true); // restore for later tests
  });

  await t.test("3. invalid input is refused cleanly - name length, phone length, notes length", async () => {
    await assert.rejects(playersPg.createPlayer({ name: "A" })); // below the 2-character minimum
    await assert.rejects(playersPg.createPlayer({ name: "X".repeat(61) })); // above the 60-character maximum
    await assert.rejects(playersPg.createPlayer({ name: "Valid Name", phone: "0".repeat(21) }));
    await assert.rejects(playersPg.createPlayer({ name: "Valid Name", notes: "x".repeat(201) }));
  });

  await t.test("4. missing player id is refused with 404", async () => {
    await assert.rejects(playersPg.getPlayerById("00000000-0000-0000-0000-000000000000"), (error) => { assert.equal(error.statusCode, 404); return true; });
    await assert.rejects(playersPg.updatePlayer("00000000-0000-0000-0000-000000000000", { name: "Someone" }), (error) => { assert.equal(error.statusCode, 404); return true; });
  });

  await t.test("5. update: partial changes apply; renaming to the same name with different capitals is fine; renaming to a taken name is refused", async () => {
    const zainab = await playersPg.createPlayer({ name: "Zainab Noor" });
    const updated = await playersPg.updatePlayer(playerA.id, { phone: "0321-9998888", notes: "VIP now" });
    assert.equal(updated.phone, "0321-9998888");
    assert.equal(updated.notes, "VIP now");
    assert.equal(updated.name, "Ali Khan", "name was left untouched by a partial update");

    const renamedSameKey = await playersPg.updatePlayer(playerA.id, { name: "ALI KHAN" }); // same nameKey as itself - allowed
    assert.equal(renamedSameKey.name, "ALI KHAN");

    await assert.rejects(
      playersPg.updatePlayer(playerA.id, { name: "zainab noor" }), // taken by a different player
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
    const stillUnchanged = await playersPg.getPlayerById(playerA.id);
    assert.equal(stillUnchanged.name, "ALI KHAN", "the refused rename left the name untouched");
    await playersPg.updatePlayer(playerA.id, { name: "Ali Khan" }); // restore for later tests
    assert.ok(zainab.id);
  });

  await t.test("6. deactivate / reactivate: deactivatedAt is set and cleared; repeating the same state is refused", async () => {
    const deactivated = await playersPg.setActive(playerA.id, false);
    assert.equal(deactivated.isActive, false);
    assert.ok(deactivated.deactivatedAt);

    await assert.rejects(
      playersPg.setActive(playerA.id, false),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already inactive/); return true; }
    );

    const reactivated = await playersPg.setActive(playerA.id, true);
    assert.equal(reactivated.isActive, true);
    assert.equal(reactivated.deactivatedAt, null, "reactivating clears deactivatedAt");

    await assert.rejects(
      playersPg.setActive(playerA.id, true),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already active/); return true; }
    );
  });

  await t.test("7. list/search: status filter (default active), name search, phone search, pagination", async () => {
    const inactiveOne = await playersPg.createPlayer({ name: "Archived Player" });
    await playersPg.setActive(inactiveOne.id, false);

    const activeOnly = await playersPg.listPlayers({});
    assert.ok(activeOnly.players.every((p) => p.isActive));
    assert.ok(!activeOnly.players.some((p) => p.name === "Archived Player"));

    const inactiveOnly = await playersPg.listPlayers({ status: "inactive" });
    assert.ok(inactiveOnly.players.every((p) => !p.isActive));
    assert.ok(inactiveOnly.players.some((p) => p.name === "Archived Player"));

    const byName = await playersPg.listPlayers({ status: "active", search: "zainab" });
    assert.ok(byName.players.some((p) => p.name === "Zainab Noor"));

    const byPhone = await playersPg.listPlayers({ status: "active", search: "9998888" });
    assert.ok(byPhone.players.some((p) => p.id === playerA.id));

    const page = await playersPg.listPlayers({ status: "active", page: 1, limit: 1 });
    assert.equal(page.players.length, 1);
    assert.equal(page.totalPages, Math.ceil(page.total / 1));
  });

  await t.test("8. the real unique index is the final guard: 2 concurrent creates for the identical name - exactly one wins", async () => {
    const attempts = await Promise.allSettled([
      playersPg.createPlayer({ name: "Race Condition Rani" }),
      playersPg.createPlayer({ name: "race   condition   rani" }), // same nameKey
    ]);
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent creates for the identical name must win");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.statusCode, 409);
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.players WHERE name_key = 'race condition rani'");
    assert.equal(count.rows[0].n, 1, "exactly one row actually committed - the database's own unique index decided this");
  });

  await t.test("9. foreign-key compatibility: a real match_players row can reference this player; a non-existent player id is refused", async () => {
    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (701, 60000) RETURNING id");
    const session = await getPool().query(
      `INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start) VALUES ($1, 701, 60000) RETURNING id`,
      [table.rows[0].id]
    );
    const match = await getPool().query(
      `INSERT INTO app.matches (session_id, number, table_id, table_number, game_mode)
       VALUES ($1, 1, $2, 701, 'frame') RETURNING id`,
      [session.rows[0].id, table.rows[0].id]
    );

    const matchPlayer = await getPool().query(
      `INSERT INTO app.match_players (match_id, position, player_id, name, seat)
       VALUES ($1, 1, $2, $3, 1) RETURNING id`,
      [match.rows[0].id, playerA.id, playerA.name]
    );
    assert.match(matchPlayer.rows[0].id, /^[0-9a-f-]{36}$/);

    await assert.rejects(
      getPool().query(
        `INSERT INTO app.match_players (match_id, position, player_id, name, seat)
         VALUES ($1, 2, '00000000-0000-0000-0000-000000000000', 'Ghost Player', 2)`,
        [match.rows[0].id]
      ),
      (error) => { assert.equal(error.code, "23503"); return true; } // foreign_key_violation
    );

    // player_id is nullable (walk-in players have none) - still accepted, same as players.service.js's own model comment.
    const walkIn = await getPool().query(
      `INSERT INTO app.match_players (match_id, position, player_id, name, seat)
       VALUES ($1, 3, NULL, 'Walk-in Wasi', 3) RETURNING id`,
      [match.rows[0].id]
    );
    assert.match(walkIn.rows[0].id, /^[0-9a-f-]{36}$/);
  });

  await t.test("10. transaction rollback: a failed multi-step change leaves nothing behind", async () => {
    const before = await playersPg.getPlayerById(playerA.id);
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE app.players SET notes = 'should not stick' WHERE id = $1", [playerA.id]);
        await client.query("INSERT INTO app.players (id, name, name_key) VALUES ($1, 'dup id', 'dup id')", [playerA.id]); // duplicate PK -> forces a rollback
      })
    );
    const after = await playersPg.getPlayerById(playerA.id);
    assert.equal(after.notes, before.notes, "the UPDATE inside the failed transaction was rolled back, not partially applied");
  });

  await t.test("isolation: the Players pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/players.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
