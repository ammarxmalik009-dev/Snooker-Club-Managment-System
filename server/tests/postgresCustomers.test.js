// Tests for the Customers PostgreSQL pilot (Phase 2, step 2.11 - see docs/POSTGRES_MIGRATION.md).
// Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason
// otherwise. Every MongoDB test, including the real customers.service.js ones, is completely
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
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.11") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Customers pilot: create/read/update/delete, search, pagination, FK compatibility", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const customersPg = require("../services/customers.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  let customerA;

  await t.test("1. create and retrieve a customer", async () => {
    customerA = await customersPg.createCustomer({ name: "  Bilal Khan  ", phone: "0300-1234567", notes: "regular" });
    assert.match(customerA.id, /^[0-9a-f-]{36}$/);
    assert.equal(customerA.name, "Bilal Khan"); // trimmed
    assert.equal(customerA.phone, "0300-1234567"); // stored as typed
    assert.equal(customerA.phoneDigits, "03001234567"); // digits-only, kept in step with phone
    assert.equal(customerA.isActive, true);
    const reread = await customersPg.getCustomerById(customerA.id);
    assert.deepEqual(reread, customerA);
  });

  await t.test("2. invalid input is refused cleanly - name length, phone length, notes length", async () => {
    await assert.rejects(
      customersPg.createCustomer({ name: "A" }), // below the 2-character minimum
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /between 2 and 60/); return true; }
    );
    await assert.rejects(customersPg.createCustomer({ name: "X".repeat(61) })); // above the 60-character maximum
    await assert.rejects(customersPg.createCustomer({ name: "Valid Name", phone: "0".repeat(21) }));
    await assert.rejects(customersPg.createCustomer({ name: "Valid Name", notes: "x".repeat(201) }));
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.customers");
    assert.equal(count.rows[0].n, 1, "none of the refused attempts left a row behind - still only customer A");
  });

  await t.test("3. phone is deliberately NOT unique - two customers can share one number (family members)", async () => {
    const sibling = await customersPg.createCustomer({ name: "Bilal's Brother", phone: "0300-1234567" });
    assert.equal(sibling.phoneDigits, "03001234567");
    assert.notEqual(sibling.id, customerA.id);
  });

  await t.test("4. missing customer id is refused with 404", async () => {
    await assert.rejects(
      customersPg.getCustomerById("00000000-0000-0000-0000-000000000000"),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
    await assert.rejects(
      customersPg.updateCustomer("00000000-0000-0000-0000-000000000000", { name: "Someone" }),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
  });

  await t.test("5. update: partial changes apply; phoneDigits stays in step with a changed phone", async () => {
    const updated = await customersPg.updateCustomer(customerA.id, { phone: "0321-9998888", notes: "VIP now" });
    assert.equal(updated.phone, "0321-9998888");
    assert.equal(updated.phoneDigits, "03219998888");
    assert.equal(updated.notes, "VIP now");
    assert.equal(updated.name, "Bilal Khan", "name was left untouched by a partial update");

    await assert.rejects(customersPg.updateCustomer(customerA.id, { name: "" })); // below minimum
    const stillUnchanged = await customersPg.getCustomerById(customerA.id);
    assert.equal(stillUnchanged.name, "Bilal Khan", "the refused update left the name untouched");
  });

  await t.test("6. list/search: name search, phone-digit search, archived filtering, pagination", async () => {
    await customersPg.createCustomer({ name: "Zainab Ali", phone: "0333-1112222" });
    await customersPg.createCustomer({ name: "Archived Customer", isActive: false });

    const byName = await customersPg.listCustomers({ search: "zainab" }); // case-insensitive
    assert.ok(byName.customers.some((c) => c.name === "Zainab Ali"));

    const byPhone = await customersPg.listCustomers({ search: "9998888" }); // digits-only search, >= 3 digits
    assert.ok(byPhone.customers.some((c) => c.id === customerA.id));

    const activeOnly = await customersPg.listCustomers({});
    assert.ok(activeOnly.customers.every((c) => c.isActive));
    assert.ok(!activeOnly.customers.some((c) => c.name === "Archived Customer"));

    const withArchived = await customersPg.listCustomers({ includeArchived: true });
    assert.ok(withArchived.customers.some((c) => c.name === "Archived Customer"));
    assert.equal(withArchived.total, activeOnly.total + 1, "includeArchived adds exactly the one archived customer to the total");

    const pageOne = await customersPg.listCustomers({ includeArchived: true, page: 1, limit: 2 });
    assert.equal(pageOne.customers.length, 2);
    assert.equal(pageOne.totalPages, Math.ceil(pageOne.total / 2));
    const pageTwo = await customersPg.listCustomers({ includeArchived: true, page: 2, limit: 2 });
    assert.notDeepEqual(pageOne.customers.map((c) => c.id), pageTwo.customers.map((c) => c.id));
  });

  await t.test("7. listCustomers reports a real booking count and last-booking date per customer", async () => {
    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (601, 60000) RETURNING id");
    const earlier = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    await getPool().query(
      `INSERT INTO app.bookings (customer_id, table_id, customer_name, table_number, start_at, end_at)
       VALUES ($1, $2, 'Bilal Khan', 601, $3, $4), ($1, $2, 'Bilal Khan', 601, $5, $6)`,
      [customerA.id, table.rows[0].id, earlier, new Date(earlier.getTime() + 3600000), later, new Date(later.getTime() + 3600000)]
    );
    const list = await customersPg.listCustomers({ search: "Bilal Khan" });
    const found = list.customers.find((c) => c.id === customerA.id);
    assert.equal(found.bookingCount, 2);
    assert.equal(new Date(found.lastBookingAt).getTime(), later.getTime());
  });

  await t.test("8. delete: no bookings -> really deleted; has bookings -> archived, not deleted", async () => {
    const noBookings = await customersPg.createCustomer({ name: "No Bookings Customer" });
    const deleteResult = await customersPg.deleteCustomer(noBookings.id);
    assert.equal(deleteResult.result, "deleted");
    await assert.rejects(customersPg.getCustomerById(noBookings.id), (error) => { assert.equal(error.statusCode, 404); return true; });

    const archiveResult = await customersPg.deleteCustomer(customerA.id); // has bookings from test 7
    assert.equal(archiveResult.result, "archived");
    const stillThere = await customersPg.getCustomerById(customerA.id);
    assert.equal(stillThere.isActive, false, "archived, not deleted - booking history stays complete");
  });

  await t.test("9. the real foreign key backs up the archive rule: a raw DELETE against a customer with bookings is refused by the database itself", async () => {
    await assert.rejects(getPool().query("DELETE FROM app.customers WHERE id = $1", [customerA.id]), (error) => {
      assert.equal(error.code, "23503"); // foreign_key_violation
      return true;
    });
  });

  await t.test("10. transaction rollback: a failed multi-step change leaves nothing behind", async () => {
    const before = await customersPg.getCustomerById(customerA.id);
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE app.customers SET notes = 'should not stick' WHERE id = $1", [customerA.id]);
        await client.query("INSERT INTO app.customers (id, name) VALUES ($1, 'duplicate id')", [customerA.id]); // duplicate PK -> forces a rollback
      })
    );
    const after = await customersPg.getCustomerById(customerA.id);
    assert.equal(after.notes, before.notes, "the UPDATE inside the failed transaction was rolled back, not partially applied");
  });

  await t.test("isolation: the Customers pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/customers.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
