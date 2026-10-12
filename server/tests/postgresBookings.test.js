// Tests for the Bookings PostgreSQL pilot (Phase 2, step 2.9 - the real, database-level overlap
// guarantee, verified against a real service for the first time - see docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real bookings.service.js ones, is completely
// unaffected.
//
// No mocks: every overlap/concurrency/rollback claim below is checked by running real SQL
// against the real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.9") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Bookings pilot: the real EXCLUDE overlap guarantee against a real service", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const bookingsPg = require("../services/bookings.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  // Minimal fixture only (no Customers service exists yet - see earlier pilots' own notes).
  const tableA = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (501, 60000) RETURNING id");
  const tableB = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (502, 60000) RETURNING id");
  const customer = await getPool().query("INSERT INTO app.customers (name) VALUES ('Booking Test') RETURNING id");
  const tableAId = tableA.rows[0].id;
  const tableBId = tableB.rows[0].id;
  const customerId = customer.rows[0].id;

  // A real club-local date a few days from now, so every booking below is safely within the
  // "not in the past, not more than 60 days ahead" rule regardless of exactly when this runs.
  const dateText = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  function fixture(tableId, startTime, durationMinutes) {
    const { startAt, endAt } = bookingsPg.resolveTimes({ date: dateText, startTime, durationMinutes });
    return { customerId, tableId, customerName: "Booking Test", tableNumber: tableId === tableAId ? 501 : 502, startAt, endAt };
  }

  let bookingA;

  await t.test("1. create and retrieve a booking", async () => {
    bookingA = await bookingsPg.createBooking(fixture(tableAId, "10:00", 60));
    assert.match(bookingA.id, /^[0-9a-f-]{36}$/);
    assert.equal(bookingA.status, "pending");
    assert.equal(bookingA.table, tableAId);
    const reread = await bookingsPg.getBookingById(bookingA.id);
    assert.deepEqual(reread, bookingA);
  });

  await t.test("2. valid non-overlapping bookings on the SAME table are both accepted (touching is fine)", async () => {
    const back2back = await bookingsPg.createBooking(fixture(tableAId, "11:00", 60)); // starts exactly when bookingA ends
    assert.equal(back2back.status, "pending");
    const laterToo = await bookingsPg.createBooking(fixture(tableAId, "14:00", 30));
    assert.equal(laterToo.status, "pending");
  });

  await t.test("3. an overlapping booking on the same table is refused - by the database itself", async () => {
    await assert.rejects(
      bookingsPg.createBooking(fixture(tableAId, "10:30", 60)), // overlaps bookingA (10:00-11:00)
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /Table 501 is already booked/);
        return true;
      }
    );
    // Confirm nothing was actually inserted for the refused attempt
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.bookings WHERE table_id = $1", [tableAId]);
    assert.equal(count.rows[0].n, 3, "still exactly the 3 bookings from tests 1-2 - the refused attempt left nothing behind");
  });

  await t.test("4. the SAME time slot on a DIFFERENT table is perfectly fine", async () => {
    const onTableB = await bookingsPg.createBooking(fixture(tableBId, "10:00", 60)); // same time as bookingA, different table
    assert.equal(onTableB.status, "pending");
  });

  await t.test("5. invalid time ranges and invalid table/customer ids are refused cleanly", async () => {
    assert.throws(() => bookingsPg.resolveTimes({ date: "2020-01-01", startTime: "10:00", durationMinutes: 60 }));
    await assert.rejects(
      bookingsPg.createBooking({ ...fixture(tableAId, "16:00", 30), tableId: "00000000-0000-0000-0000-000000000000" }),
      (error) => { assert.equal(error.statusCode, 404); assert.equal(error.message, "Table not found"); return true; }
    );
    await assert.rejects(
      bookingsPg.createBooking({ ...fixture(tableAId, "16:00", 30), customerId: "00000000-0000-0000-0000-000000000000" }),
      (error) => { assert.equal(error.statusCode, 404); assert.equal(error.message, "Customer not found"); return true; }
    );
    // end_at > start_at is enforced by the schema's own CHECK - a zero-length booking is refused
    await assert.rejects(
      (async () => {
        const f = fixture(tableAId, "17:00", 60);
        return bookingsPg.createBooking({ ...f, endAt: f.startAt });
      })()
    );
  });

  await t.test("6. update: rescheduling into a clash is refused; rescheduling into a free slot works", async () => {
    const moving = await bookingsPg.createBooking(fixture(tableBId, "18:00", 60));
    const clashingSlot = bookingsPg.resolveTimes({ date: dateText, startTime: "10:30", durationMinutes: 60 }); // overlaps bookingA (10:00-11:00) on table A
    await assert.rejects(
      bookingsPg.updateBooking(moving.id, { startAt: clashingSlot.startAt, endAt: clashingSlot.endAt, tableId: tableAId, tableNumber: 501 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Table 501 is already booked/); return true; }
    );
    const { startAt, endAt } = bookingsPg.resolveTimes({ date: dateText, startTime: "20:00", durationMinutes: 60 });
    const moved = await bookingsPg.updateBooking(moving.id, { startAt, endAt });
    assert.equal(new Date(moved.startAt).getTime(), startAt.getTime());
  });

  await t.test("7. cancellation immediately frees the slot - a new booking for the exact same time now succeeds", async () => {
    const toCancel = await bookingsPg.createBooking(fixture(tableBId, "21:00", 60));
    await assert.rejects(bookingsPg.createBooking(fixture(tableBId, "21:00", 60))); // still taken
    const cancelled = await bookingsPg.cancelBooking(toCancel.id, "changed their mind");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "changed their mind");
    const rebooked = await bookingsPg.createBooking(fixture(tableBId, "21:00", 60)); // now free
    assert.equal(rebooked.status, "pending");

    await assert.rejects(
      bookingsPg.cancelBooking(cancelled.id),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already cancelled/); return true; }
    );
  });

  await t.test("8. confirm: pending -> confirmed works once, refused the second time", async () => {
    const pending = await bookingsPg.createBooking(fixture(tableBId, "23:00", 30));
    const confirmed = await bookingsPg.confirmBooking(pending.id);
    assert.equal(confirmed.status, "confirmed");
    await assert.rejects(
      bookingsPg.confirmBooking(pending.id),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already confirmed/); return true; }
    );
  });

  await t.test("9. concurrent overlapping booking attempts on a FRESH table: exactly one wins, no mocks", async () => {
    const freshTable = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (503, 60000) RETURNING id");
    const freshTableId = freshTable.rows[0].id;
    const sameSlot = () => bookingsPg.createBooking(fixture(freshTableId, "09:00", 60));
    // 6 genuinely simultaneous attempts for the IDENTICAL table + time slot.
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, sameSlot));
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    assert.equal(succeeded.length, 1, "exactly one of the 6 concurrent attempts for the identical slot must win");
    assert.equal(failed.length, 5);
    for (const f of failed) assert.equal(f.reason.statusCode, 409);

    const count = await getPool().query("SELECT count(*)::int AS n FROM app.bookings WHERE table_id = $1", [freshTableId]);
    assert.equal(count.rows[0].n, 1, "exactly one row actually committed - the database's own EXCLUDE constraint decided this, not application code");
  });

  await t.test("10. concurrent NON-overlapping attempts (different tables) all succeed, proving the lock isn't overly broad", async () => {
    const freshTables = await Promise.all(
      [504, 505, 506].map((n) => getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES ($1, 60000) RETURNING id", [n]))
    );
    const results = await Promise.all(
      freshTables.map((t2) => bookingsPg.createBooking(fixture(t2.rows[0].id, "08:00", 60)))
    );
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === "pending"));
  });

  await t.test("isolation: the Bookings pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/bookings.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
