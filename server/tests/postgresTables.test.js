// Tests for the Tables PostgreSQL pilot (Phase 2, step 2.10 - a model every earlier pilot has
// only ever touched as a bare fixture row, finally given its own repository - see
// docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real tables.service.js ones, is completely
// unaffected.
//
// No mocks: every constraint/rollback claim below is checked by running real SQL against the
// real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.10") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Tables pilot: create/read/update/delete, uniqueness, status rules, FK compatibility", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const tablesPg = require("../services/tables.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  let tableA;

  await t.test("1. create and retrieve a table, by id and by number", async () => {
    tableA = await tablesPg.createTable({ tableNumber: 501, name: "VIP Table", hourlyRate: 60000 });
    assert.match(tableA.id, /^[0-9a-f-]{36}$/);
    assert.equal(tableA.tableNumber, 501);
    assert.equal(tableA.name, "VIP Table");
    assert.equal(tableA.hourlyRate, 60000);
    assert.equal(typeof tableA.hourlyRate, "number"); // bigint column, converted from the driver's string
    assert.equal(tableA.status, "available");

    const byId = await tablesPg.getTableById(tableA.id);
    assert.deepEqual(byId, tableA);
    const byNumber = await tablesPg.getTableByNumber(501);
    assert.deepEqual(byNumber, tableA);
  });

  await t.test("2. unique table numbers: a duplicate is refused, the original is unchanged", async () => {
    await assert.rejects(
      tablesPg.createTable({ tableNumber: 501, name: "Someone else's table", hourlyRate: 50000 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Table number 501 already exists/); return true; }
    );
    const stillOriginal = await tablesPg.getTableByNumber(501);
    assert.equal(stillOriginal.name, "VIP Table");
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.tables WHERE table_number = 501");
    assert.equal(count.rows[0].n, 1, "exactly one row for table 501 - the refused duplicate left nothing behind");
  });

  await t.test("3. invalid table numbers and rates are refused by the schema's own CHECK constraints", async () => {
    await assert.rejects(tablesPg.createTable({ tableNumber: 0, hourlyRate: 60000 })); // below 1
    await assert.rejects(tablesPg.createTable({ tableNumber: 1000, hourlyRate: 60000 })); // above 999
    await assert.rejects(tablesPg.createTable({ tableNumber: 502, hourlyRate: -1 })); // negative
    await assert.rejects(tablesPg.createTable({ tableNumber: 502, hourlyRate: 10_000_001 })); // above the max
  });

  await t.test("4. valid and invalid statuses", async () => {
    const reserved = await tablesPg.createTable({ tableNumber: 503, hourlyRate: 60000, status: "reserved" });
    assert.equal(reserved.status, "reserved");
    await assert.rejects(
      tablesPg.createTable({ tableNumber: 504, hourlyRate: 60000, status: "closed" }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /Status must be one of/); return true; }
    );
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.tables WHERE table_number = 504");
    assert.equal(count.rows[0].n, 0, "the invalid-status attempt was refused before any INSERT was even tried");
  });

  await t.test("5. updating a table: name/rate/number change freely; renumbering into a taken number is refused", async () => {
    const updated = await tablesPg.updateTable(tableA.id, { name: "Championship Table", hourlyRate: 70000 });
    assert.equal(updated.name, "Championship Table");
    assert.equal(updated.hourlyRate, 70000);

    await assert.rejects(
      tablesPg.updateTable(tableA.id, { tableNumber: 503 }), // table 503 already exists (test 4)
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
    const unchanged = await tablesPg.getTableById(tableA.id);
    assert.equal(unchanged.tableNumber, 501, "the refused renumber left the original number untouched");

    const renumbered = await tablesPg.updateTable(tableA.id, { tableNumber: 505 });
    assert.equal(renumbered.tableNumber, 505);
  });

  await t.test("6. status can't be changed by hand while a session is open on the table (matches tables.service.js)", async () => {
    await getPool().query(
      `INSERT INTO app.sessions (table_id, table_number, table_name, hourly_rate_at_start)
       VALUES ($1, 505, 'Championship Table', 70000)`,
      [tableA.id]
    );
    await assert.rejects(
      tablesPg.updateTable(tableA.id, { status: "maintenance" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /active session/); return true; }
    );
    // Name/rate changes are still allowed while the session is open (only status is blocked).
    const stillWorks = await tablesPg.updateTable(tableA.id, { name: "Championship Table (renamed)" });
    assert.equal(stillWorks.name, "Championship Table (renamed)");
    await getPool().query("UPDATE app.sessions SET is_open = false, status = 'completed', ended_at = now() WHERE table_id = $1", [tableA.id]);
  });

  await t.test("7. foreign-key compatibility: a real booking can reference this table", async () => {
    const customer = await getPool().query("INSERT INTO app.customers (name) VALUES ('Table FK Test') RETURNING id");
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    const booking = await getPool().query(
      `INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at)
       VALUES ($1, $2, 'Table FK Test', 505, $3, $4) RETURNING id`,
      [customer.rows[0].id, tableA.id, startAt, endAt]
    );
    assert.match(booking.rows[0].id, /^[0-9a-f-]{36}$/);
  });

  await t.test("8. deletion restrictions: occupied status, an active session, or an upcoming booking all refuse the delete", async () => {
    const occupied = await tablesPg.createTable({ tableNumber: 506, hourlyRate: 60000, status: "occupied" });
    await assert.rejects(
      tablesPg.deleteTable(occupied.id),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /currently occupied/); return true; }
    );

    const withBooking = await tablesPg.createTable({ tableNumber: 507, hourlyRate: 60000 });
    const customer = await getPool().query("INSERT INTO app.customers (name) VALUES ('Delete Test') RETURNING id");
    const startAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    await getPool().query(
      `INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at)
       VALUES ($1, $2, 'Delete Test', 507, $3, $4)`,
      [customer.rows[0].id, withBooking.id, startAt, endAt]
    );
    await assert.rejects(
      tablesPg.deleteTable(withBooking.id),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /upcoming booking/); return true; }
    );

    // Even bypassing the application-level check entirely, the database's own foreign-key
    // RESTRICT (no ON DELETE CASCADE declared in step 2.3's schema) refuses the DELETE outright.
    await assert.rejects(getPool().query("DELETE FROM app.tables WHERE id = $1", [withBooking.id]), (error) => {
      assert.equal(error.code, "23503"); // foreign_key_violation
      return true;
    });

    const freeTable = await tablesPg.createTable({ tableNumber: 508, hourlyRate: 60000 });
    const deleted = await tablesPg.deleteTable(freeTable.id);
    assert.equal(deleted.tableNumber, 508);
    await assert.rejects(tablesPg.getTableById(freeTable.id), (error) => { assert.equal(error.statusCode, 404); return true; });
  });

  await t.test("9. listTables: status filter and name/number search behave like tables.service.js", async () => {
    const reservedOnly = await tablesPg.listTables({ status: "reserved" });
    assert.ok(reservedOnly.every((table) => table.status === "reserved"));
    assert.ok(reservedOnly.some((table) => table.tableNumber === 503));

    const byNumberSearch = await tablesPg.listTables({ search: "505" });
    assert.ok(byNumberSearch.some((table) => table.tableNumber === 505));

    const byNameSearch = await tablesPg.listTables({ search: "championship" }); // case-insensitive
    assert.ok(byNameSearch.some((table) => table.id === tableA.id));

    const all = await tablesPg.listTables();
    const sorted = [...all].sort((a, b) => a.tableNumber - b.tableNumber);
    assert.deepEqual(all.map((table) => table.tableNumber), sorted.map((table) => table.tableNumber));
  });

  await t.test("10. getTableSummary: counts grouped by status, plus a total", async () => {
    const summary = await tablesPg.getTableSummary();
    const all = await tablesPg.listTables();
    assert.equal(summary.total, all.length);
    for (const status of tablesPg.TABLE_STATUSES) {
      const expected = all.filter((table) => table.status === status).length;
      assert.equal(summary[status], expected);
    }
  });

  await t.test("11. transaction rollback: a failed multi-step change leaves nothing behind", async () => {
    const before = await tablesPg.getTableByNumber(503);
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE app.tables SET name = 'should not stick' WHERE table_number = 503");
        await client.query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (503, 10000)"); // duplicate -> forces a rollback
      })
    );
    const after = await tablesPg.getTableByNumber(503);
    assert.equal(after.name, before.name, "the UPDATE inside the failed transaction was rolled back, not partially applied");
  });

  await t.test("isolation: the Tables pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/tables.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
