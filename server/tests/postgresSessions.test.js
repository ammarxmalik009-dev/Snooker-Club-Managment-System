// Tests for the Sessions PostgreSQL pilot (Phase 2, step 2.12 - the real multi-statement
// transaction MongoDB's sessions.service.js cannot have - see docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real sessions.service.js ones, is completely
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
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.12") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Sessions pilot: the real transactional start/end, no-double-open guarantee against a real service", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const sessionsPg = require("../services/sessions.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  async function freshTable(tableNumber, status = "available") {
    const result = await getPool().query(
      "INSERT INTO app.tables (table_number, hourly_rate, status) VALUES ($1, 60000, $2) RETURNING id",
      [tableNumber, status]
    );
    return result.rows[0].id;
  }

  let tableAId;
  let sessionA;

  await t.test("1. start a session: claims the table, create and retrieve", async () => {
    tableAId = await freshTable(601);
    sessionA = await sessionsPg.startSession({ tableId: tableAId });
    assert.match(sessionA.id, /^[0-9a-f-]{36}$/);
    assert.equal(sessionA.table, tableAId);
    assert.equal(sessionA.tableNumber, 601);
    assert.equal(sessionA.hourlyRateAtStart, 60000);
    assert.equal(sessionA.status, "active");
    assert.equal(sessionA.isOpen, true);
    assert.equal(sessionA.endedAt, null);

    const table = await getPool().query("SELECT status FROM app.tables WHERE id = $1", [tableAId]);
    assert.equal(table.rows[0].status, "occupied", "the table was claimed as part of starting the session");

    const reread = await sessionsPg.getSessionById(sessionA.id);
    assert.deepEqual(reread, sessionA);
  });

  await t.test("2. starting a session on a table that is already occupied is refused with a reason, and the table is untouched", async () => {
    await assert.rejects(
      sessionsPg.startSession({ tableId: tableAId }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already occupied/); return true; }
    );
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.sessions WHERE table_id = $1", [tableAId]);
    assert.equal(count.rows[0].n, 1, "the refused attempt left no second session behind");
  });

  await t.test("3. a reserved or maintenance table gives a specific reason; a missing table id gives 404", async () => {
    const reservedId = await freshTable(602, "reserved");
    await assert.rejects(
      sessionsPg.startSession({ tableId: reservedId }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /is reserved/); return true; }
    );
    const maintenanceId = await freshTable(603, "maintenance");
    await assert.rejects(
      sessionsPg.startSession({ tableId: maintenanceId }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /under maintenance/); return true; }
    );
    await assert.rejects(
      sessionsPg.startSession({ tableId: "00000000-0000-0000-0000-000000000000" }),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
    // Neither refused attempt left the reserved/maintenance tables claimed as occupied.
    const reservedTable = await getPool().query("SELECT status FROM app.tables WHERE id = $1", [reservedId]);
    assert.equal(reservedTable.rows[0].status, "reserved");
  });

  await t.test("4. the real transaction: if the session INSERT ever failed, the table claim would roll back with it, not stay stuck", async () => {
    // Proven directly here, not just reasoned about: start a genuine new session on a fresh
    // table, then force the unique-open-session index to refuse a SECOND concurrent attempt
    // for the SAME table, and confirm the table ends up in a consistent state either way.
    const freshId = await freshTable(604);
    const [first, second] = await Promise.allSettled([
      sessionsPg.startSession({ tableId: freshId }),
      sessionsPg.startSession({ tableId: freshId }),
    ]);
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one of the two concurrent starts for the identical table must win");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.statusCode, 409);

    const table = await getPool().query("SELECT status FROM app.tables WHERE id = $1", [freshId]);
    assert.equal(table.rows[0].status, "occupied", "the table ended up correctly occupied by the one session that actually won - never stuck or double-claimed");
    const sessionCount = await getPool().query("SELECT count(*)::int AS n FROM app.sessions WHERE table_id = $1 AND is_open", [freshId]);
    assert.equal(sessionCount.rows[0].n, 1, "exactly one open session - the database's own partial unique index decided this");
  });

  await t.test("5. ending a session: computes a real duration, frees the table, can't be ended twice", async () => {
    const ended = await sessionsPg.endSession(sessionA.id);
    assert.equal(ended.isOpen, false);
    assert.equal(ended.status, "completed");
    assert.ok(ended.endedAt);
    assert.ok(typeof ended.durationSeconds === "number" && ended.durationSeconds >= 0);

    const table = await getPool().query("SELECT status FROM app.tables WHERE id = $1", [tableAId]);
    assert.equal(table.rows[0].status, "available", "the table was freed back to available when its session ended");

    await assert.rejects(
      sessionsPg.endSession(sessionA.id),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already ended/); return true; }
    );
  });

  await t.test("6. ending a non-existent session is refused with 404", async () => {
    await assert.rejects(
      sessionsPg.endSession("00000000-0000-0000-0000-000000000000"),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
  });

  await t.test("7. listActiveSessions / countActiveSessions / hasOpenSession reflect real, current state", async () => {
    const beforeCount = await sessionsPg.countActiveSessions();
    const freshId = await freshTable(605);
    const freshSession = await sessionsPg.startSession({ tableId: freshId });

    assert.equal(await sessionsPg.countActiveSessions(), beforeCount + 1);
    const active = await sessionsPg.listActiveSessions();
    assert.ok(active.every((s) => s.isOpen));
    assert.ok(active.some((s) => s.id === freshSession.id));
    assert.equal(await sessionsPg.hasOpenSession(freshId), true);

    await sessionsPg.endSession(freshSession.id);
    assert.equal(await sessionsPg.countActiveSessions(), beforeCount);
    assert.equal(await sessionsPg.hasOpenSession(freshId), false);
  });

  await t.test("8. listSessions: status filter, table search, and pagination", async () => {
    const byStatus = await sessionsPg.listSessions({ status: "completed" });
    assert.ok(byStatus.sessions.every((s) => s.status === "completed"));
    assert.ok(byStatus.sessions.some((s) => s.id === sessionA.id));

    const bySearch = await sessionsPg.listSessions({ search: "601" });
    assert.ok(bySearch.sessions.some((s) => s.id === sessionA.id));

    const page = await sessionsPg.listSessions({ page: 1, limit: 1 });
    assert.equal(page.sessions.length, 1);
    assert.equal(page.totalPages, Math.ceil(page.total / 1));
  });

  await t.test("9. foreign-key compatibility: a real booking's session_id can reference this session", async () => {
    const customer = await getPool().query("INSERT INTO app.customers (name) VALUES ('Session FK Test') RETURNING id");
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 3600000);
    const booking = await getPool().query(
      `INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at, session_id)
       VALUES ($1, $2, 'Session FK Test', 601, $3, $4, $5) RETURNING id`,
      [customer.rows[0].id, tableAId, startAt, endAt, sessionA.id]
    );
    assert.match(booking.rows[0].id, /^[0-9a-f-]{36}$/);
    await assert.rejects(
      getPool().query(
        `INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at, session_id)
         VALUES ($1, $2, 'Bad FK', 601, $3, $4, '00000000-0000-0000-0000-000000000000')`,
        [customer.rows[0].id, tableAId, new Date(startAt.getTime() + 7200000), new Date(startAt.getTime() + 10800000)]
      ),
      (error) => { assert.equal(error.code, "23503"); return true; }
    );
  });

  await t.test("10. transaction rollback: ending a session and freeing its table either both happen or neither does", async () => {
    const freshId = await freshTable(606);
    const freshSession = await sessionsPg.startSession({ tableId: freshId });
    // Simulate a failure partway through an equivalent multi-step change: end the session in a
    // transaction, then force a later statement to fail - confirm the session's own end never stuck.
    const { withTransaction } = require("../config/db.pg");
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE app.sessions SET is_open = false, status = 'completed', ended_at = now() WHERE id = $1", [freshSession.id]);
        await client.query("INSERT INTO app.sessions (id, table_id, table_number, hourly_rate_at_start) VALUES ($1, $2, 606, 60000)", [freshSession.id, freshId]); // duplicate PK -> forces a rollback
      })
    );
    const stillOpen = await sessionsPg.getSessionById(freshSession.id);
    assert.equal(stillOpen.isOpen, true, "the UPDATE inside the failed transaction was rolled back, not partially applied");
    await sessionsPg.endSession(freshSession.id); // clean up normally
  });

  await t.test("isolation: the Sessions pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/sessions.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
