// Tests for the CafeOrders PostgreSQL pilot (Phase 2, step 2.15 - see
// docs/POSTGRES_MIGRATION.md). Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A);
// SKIPPED with a clear reason otherwise. Every MongoDB test, including the real
// cafeOrders.service.js ones, is completely unaffected.
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
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.15") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL CafeOrders pilot: tab lifecycle, snapshot behaviour, real concurrency, rollback", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const cafeOrdersPg = require("../services/cafeOrders.pg.service");
  const productsPg = require("../services/products.pg.service");
  const categoriesPg = require("../services/categories.pg.service");
  const sessionsPg = require("../services/sessions.pg.service");

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  const drinks = await categoriesPg.createCategory({ name: "Drinks" });

  async function freshSession(tableNumber) {
    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES ($1, 60000) RETURNING id", [tableNumber]);
    return sessionsPg.startSession({ tableId: table.rows[0].id });
  }

  let sessionA;
  let cola;

  await t.test("1. add a product-based item: snapshot taken, free stock reduced", async () => {
    sessionA = await freshSession(901);
    cola = await productsPg.createProduct({ name: "Cola", categoryId: drinks.id, price: 8000, stockQuantity: 3 });

    const item = await cafeOrdersPg.addItem({ sessionId: sessionA.id, productId: cola.id, quantity: 2, consumer: "Ali" });
    assert.equal(item.description, "Cola");
    assert.equal(item.categoryName, "Drinks");
    assert.equal(item.unitPrice, 8000);
    assert.equal(item.quantity, 2);
    assert.equal(item.consumer, "Ali");
    assert.equal(item.status, "open");
    assert.equal(item.product, cola.id);

    const reserved = await cafeOrdersPg.openTabQuantities([cola.id]);
    assert.equal(reserved.get(cola.id), 2, "2 units now reserved on this open tab");
  });

  await t.test("2. a typed-in item has product = null and its own price/description", async () => {
    const manual = await cafeOrdersPg.addItem({ sessionId: sessionA.id, description: "Samosa", unitPrice: 4000, quantity: 1 });
    assert.equal(manual.product, null);
    assert.equal(manual.description, "Samosa");
    assert.equal(manual.unitPrice, 4000);
  });

  await t.test("3. free stock respects OTHER open tabs: only 1 Cola left after session A took 2 of 3", async () => {
    const sessionB = await freshSession(902);
    await assert.rejects(
      cafeOrdersPg.addItem({ sessionId: sessionB.id, productId: cola.id, quantity: 2 }),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "Only 1 Cola available"); return true; }
    );
    const ok = await cafeOrdersPg.addItem({ sessionId: sessionB.id, productId: cola.id, quantity: 1 });
    assert.equal(ok.quantity, 1);
    await assert.rejects(
      cafeOrdersPg.addItem({ sessionId: sessionB.id, productId: cola.id, quantity: 1 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /out of stock/); return true; }
    );
  });

  await t.test("4. a product that doesn't track stock is always available regardless of quantity", async () => {
    const tea = await productsPg.createProduct({ name: "Tea", categoryId: drinks.id, price: 5000, trackStock: false, stockQuantity: 0 });
    const item = await cafeOrdersPg.addItem({ sessionId: sessionA.id, productId: tea.id, quantity: 50 });
    assert.equal(item.quantity, 50);
  });

  await t.test("5. a later price change never changes what was already ordered (the snapshot)", async () => {
    await getPool().query("UPDATE app.products SET price = 9900 WHERE id = $1", [cola.id]);
    const list = await cafeOrdersPg.listItems(sessionA.id);
    const colaLine = list.items.find((i) => i.description === "Cola");
    assert.equal(colaLine.unitPrice, 8000, "the snapshot taken when the item was added, not today's price");
  });

  await t.test("6. inactive products can't be added, and invalid input is refused", async () => {
    const coffee = await productsPg.createProduct({ name: "Coffee", categoryId: drinks.id, price: 6000, status: "inactive" });
    await assert.rejects(
      cafeOrdersPg.addItem({ sessionId: sessionA.id, productId: coffee.id, quantity: 1 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /not on sale/); return true; }
    );
    await assert.rejects(cafeOrdersPg.addItem({ sessionId: "00000000-0000-0000-0000-000000000000", description: "X", unitPrice: 1, quantity: 1 }), (error) => { assert.equal(error.statusCode, 404); return true; });
  });

  await t.test("7. update and remove: only open items can change; removed items stay in history", async () => {
    const item = await cafeOrdersPg.addItem({ sessionId: sessionA.id, description: "Chips", unitPrice: 3000, quantity: 1 });
    const updated = await cafeOrdersPg.updateItem(sessionA.id, item.id, { consumer: "Bilal" });
    assert.equal(updated.consumer, "Bilal");

    const removed = await cafeOrdersPg.removeItem(sessionA.id, item.id);
    assert.equal(removed.status, "removed");
    await assert.rejects(
      cafeOrdersPg.updateItem(sessionA.id, item.id, { consumer: "Someone" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already removed/); return true; }
    );
    const stillThere = await getPool().query("SELECT status FROM app.cafe_orders WHERE id = $1", [item.id]);
    assert.equal(stillThere.rows[0].status, "removed", "kept for history, not deleted");

    // listItems itself excludes "removed" items (status <> 'removed', matching
    // cafeOrders.service.js's own filter exactly) - the row surviving in the database (just
    // confirmed above with a direct query) is what "kept for history" actually means, not that
    // it still shows up on the live tab.
    const list = await cafeOrdersPg.listItems(sessionA.id);
    assert.ok(!list.items.some((i) => i.id === item.id));
  });

  await t.test("8. updating quantity re-checks free stock, counting the item's own current quantity correctly", async () => {
    const sessionC = await freshSession(903);
    const stocked = await productsPg.createProduct({ name: "Juice", categoryId: drinks.id, price: 7000, stockQuantity: 3 });
    const item = await cafeOrdersPg.addItem({ sessionId: sessionC.id, productId: stocked.id, quantity: 2 });
    await assert.rejects(
      cafeOrdersPg.updateItem(sessionC.id, item.id, { quantity: 4 }),
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
    const grew = await cafeOrdersPg.updateItem(sessionC.id, item.id, { quantity: 3 }); // allowed: only 1 MORE needed, exactly what's free
    assert.equal(grew.quantity, 3);
  });

  await t.test("9. whole-session bill closes the tab; a match-only bill does not", async () => {
    const sessionD = await freshSession(904);
    const table904 = await getPool().query("SELECT id FROM app.tables WHERE table_number = 904");
    await cafeOrdersPg.addItem({ sessionId: sessionD.id, description: "Snack", unitPrice: 1000, quantity: 1 });

    // A real match bill (match_id NOT NULL) must NOT close the tab - the session may go on with
    // more matches, and open items go onto the next bill (cafeOrders.service.js's own rule).
    const match = await getPool().query(
      `INSERT INTO app.matches (session_id, number, table_id, table_number, game_mode) VALUES ($1, 1, $2, 904, 'century') RETURNING id`,
      [sessionD.id, table904.rows[0].id]
    );
    await getPool().query(
      `INSERT INTO app.bills (bill_number, session_id, table_number, session_started_at, session_ended_at, duration_seconds, billed_minutes,
                               game_mode, quantity, unit_price, subtotal, total, payer_rule, match_id)
       VALUES ('B-TEST-0001', $1, 904, now(), now(), 0, 0, 'century', 1, 1000, 1000, 1000, 'split', $2)`,
      [sessionD.id, match.rows[0].id]
    );

    const stillOpen = await cafeOrdersPg.addItem({ sessionId: sessionD.id, description: "Still open", unitPrice: 500, quantity: 1 });
    assert.equal(stillOpen.status, "open", "a real match bill must not be confused with a whole-session bill");

    // A whole-session bill (match_id IS NULL) DOES close the tab.
    await getPool().query(
      `INSERT INTO app.bills (bill_number, session_id, table_number, session_started_at, session_ended_at, duration_seconds, billed_minutes,
                               game_mode, quantity, unit_price, subtotal, total, payer_rule)
       VALUES ('B-TEST-0002', $1, 904, now(), now(), 0, 0, 'century', 1, 1000, 1000, 1000, 'split')`,
      [sessionD.id]
    );
    await assert.rejects(
      cafeOrdersPg.addItem({ sessionId: sessionD.id, description: "Too late", unitPrice: 500, quantity: 1 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already billed \(B-TEST-0002\)/); return true; }
    );
  });

  await t.test("10. openTabQuantities aggregates correctly across multiple sessions and products", async () => {
    const quantities = await cafeOrdersPg.openTabQuantities();
    assert.ok(quantities.get(cola.id) >= 3, "cola reserved across session A and session B's open tabs");
  });

  await t.test("11. real concurrency: the product row lock prevents overselling reserved tab stock", async () => {
    const limited = await productsPg.createProduct({ name: "Limited Soda", categoryId: drinks.id, price: 5000, stockQuantity: 5 });
    const raceSessions = await Promise.all([905, 906, 907, 908, 909, 910].map((n) => freshSession(n)));
    const attempts = await Promise.allSettled(
      raceSessions.map((session) => cafeOrdersPg.addItem({ sessionId: session.id, productId: limited.id, quantity: 1 }))
    );
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    assert.equal(succeeded.length, 5, "exactly 5 of the 6 concurrent 1-unit reservations for a stock of 5 must win");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.statusCode, 409);

    const reserved = await cafeOrdersPg.openTabQuantities([limited.id]);
    assert.equal(reserved.get(limited.id), 5, "never more than the real physical stock was reserved, decided by the database's own row lock, not application code");
  });

  await t.test("12. foreign-key behaviour: a non-existent session or product is refused cleanly", async () => {
    await assert.rejects(
      cafeOrdersPg.addItem({ sessionId: sessionA.id, productId: "00000000-0000-0000-0000-000000000000", quantity: 1 }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /Product not found/); return true; }
    );
  });

  await t.test("13. transaction rollback: a failed insert never leaves a half-added item behind", async () => {
    const before = await getPool().query("SELECT count(*)::int AS n FROM app.cafe_orders WHERE session_id = $1", [sessionA.id]);
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(
          `INSERT INTO app.cafe_orders (session_id, table_number, description, unit_price, quantity)
           VALUES ($1, 901, 'Will be rolled back', 1000, 1)`,
          [sessionA.id]
        );
        await client.query("INSERT INTO app.cafe_orders (session_id, table_number, description, unit_price, quantity) VALUES ($1, 901, 'bad', 1000, 0)", [sessionA.id]); // quantity 0 violates the schema's own CHECK -> forces a rollback
      })
    );
    const after = await getPool().query("SELECT count(*)::int AS n FROM app.cafe_orders WHERE session_id = $1", [sessionA.id]);
    assert.equal(after.rows[0].n, before.rows[0].n, "the first INSERT inside the failed transaction was rolled back too, not left behind");
  });

  await t.test("isolation: the CafeOrders pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/cafeOrders.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
