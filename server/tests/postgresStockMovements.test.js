// Tests for the StockMovements PostgreSQL pilot (Phase 2, step 2.15 - see
// docs/POSTGRES_MIGRATION.md). Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED
// with a clear reason otherwise. Every MongoDB test, including the real stock.service.js ones,
// is completely unaffected.
//
// No mocks: every constraint/concurrency/rollback claim below is checked by running real SQL
// against the real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");
const { dateInTimeZone } = require("../utils/time");

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

test("PostgreSQL StockMovements pilot: restock/adjust/waste, atomic bounds, real concurrency, rollback", { skip: skipReason }, async (t) => {
  const { getPool, closePool, withTransaction } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const stockPg = require("../services/stockMovements.pg.service");
  const productsPg = require("../services/products.pg.service");
  const categoriesPg = require("../services/categories.pg.service");
  const env = require("../config/env"); // required here, not at module top, so DATABASE_URL is already set first (see this file's own history)

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  const category = await categoriesPg.createCategory({ name: "Drinks" });
  async function freshProduct(name, overrides = {}) {
    return productsPg.createProduct({ name, categoryId: category.id, price: 8000, stockQuantity: 5, ...overrides });
  }

  await t.test("1. restock increases stock and records a correctly-balanced movement", async () => {
    const cola = await freshProduct("Cola");
    const result = await stockPg.restock(cola.id, { quantity: 24, reason: "Delivery" });
    assert.equal(result.product.stockQuantity, 29);
    assert.equal(result.movement.type, "restock");
    assert.equal(result.movement.quantity, 24);
    assert.equal(result.movement.balanceAfter, 29);
    assert.equal(result.movement.reason, "Delivery");
  });

  await t.test("2. adjust: positive adjustment, waste (always a reduction regardless of sign)", async () => {
    const cola = await freshProduct("Cola Adjust");
    const up = await stockPg.adjust(cola.id, { type: "adjustment", quantity: 3, reason: "Counted extra" });
    assert.equal(up.product.stockQuantity, 8);
    assert.equal(up.movement.quantity, 3);

    const waste = await stockPg.adjust(cola.id, { type: "waste", quantity: 2, reason: "Broken bottles" });
    assert.equal(waste.product.stockQuantity, 6);
    assert.equal(waste.movement.type, "waste");
    assert.equal(waste.movement.quantity, -2, "waste is always stored as a negative quantity, even though the input was positive");
  });

  await t.test("3. stock boundaries: never below 0, never above the maximum", async () => {
    const low = await freshProduct("Low Stock", { stockQuantity: 2 });
    await assert.rejects(
      stockPg.adjust(low.id, { type: "waste", quantity: 5, reason: "Too many" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Only 2 Low Stock in stock - stock can't go below 0/); return true; }
    );
    const stillTwo = await getPool().query("SELECT stock_quantity FROM app.products WHERE id = $1", [low.id]);
    assert.equal(stillTwo.rows[0].stock_quantity, 2, "the refused adjustment left stock completely unchanged");

    const high = await freshProduct("High Stock", { stockQuantity: 999_999 });
    await assert.rejects(
      stockPg.restock(high.id, { quantity: 10 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Stock can be at most 1,000,000/); return true; }
    );
    await stockPg.restock(high.id, { quantity: 1 }); // exactly to the maximum is fine
    const atMax = await getPool().query("SELECT stock_quantity FROM app.products WHERE id = $1", [high.id]);
    assert.equal(atMax.rows[0].stock_quantity, 1_000_000);
  });

  await t.test("4. manual stock operations are refused for products that don't track stock, and for missing products", async () => {
    const madeToOrder = await freshProduct("Made To Order", { trackStock: false, stockQuantity: 0 });
    await assert.rejects(
      stockPg.restock(madeToOrder.id, { quantity: 5 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /isn't counted/); return true; }
    );
    await assert.rejects(
      stockPg.adjust("00000000-0000-0000-0000-000000000000", { type: "adjustment", quantity: 1, reason: "x" }),
      (error) => { assert.equal(error.statusCode, 404); return true; }
    );
  });

  await t.test("5. recordInitialStock: only for tracked products with real starting stock", async () => {
    const withStock = await freshProduct("Has Initial Stock", { stockQuantity: 10 });
    const movement = await stockPg.recordInitialStock(withStock);
    assert.equal(movement.type, "initial");
    assert.equal(movement.quantity, 10);
    assert.equal(movement.balanceAfter, 10);

    const zeroStock = await freshProduct("Zero Initial Stock", { stockQuantity: 0 });
    assert.equal(await stockPg.recordInitialStock(zeroStock), null, "no movement for a product started at 0");

    const untracked = await freshProduct("Untracked Initial", { trackStock: false, stockQuantity: 0 });
    assert.equal(await stockPg.recordInitialStock(untracked), null, "no movement for an untracked product");
  });

  await t.test("6. listMovements: filter by product, type, club-local date range, and pagination", async () => {
    const cola = await freshProduct("Cola Movements");
    await stockPg.restock(cola.id, { quantity: 10, reason: "A" });
    await stockPg.adjust(cola.id, { type: "waste", quantity: 2, reason: "B" });

    const byProduct = await stockPg.listMovements({ productId: cola.id });
    assert.ok(byProduct.movements.every((m) => m.product === cola.id));
    assert.ok(byProduct.movements.length >= 2);

    const byType = await stockPg.listMovements({ type: "waste" });
    assert.ok(byType.movements.every((m) => m.type === "waste"));
    assert.ok(byType.total >= 1);

    const today = dateInTimeZone(new Date(), env.clubTimeZone); // club-local "today", not UTC - listMovements filters by the same rule
    const byDate = await stockPg.listMovements({ productId: cola.id, from: today, to: today });
    assert.ok(byDate.movements.length >= 2, "today's club-local date range includes movements made moments ago");

    const page = await stockPg.listMovements({ productId: cola.id, page: 1, limit: 1 });
    assert.equal(page.movements.length, 1);
    assert.equal(page.totalPages, Math.ceil(page.total / 1));
  });

  await t.test("7. real concurrency: 10 requests racing to take 1 unit each from a stock of 5 - exactly 5 succeed, stock ends at 0, never negative", async () => {
    const five = await freshProduct("Race Stock", { stockQuantity: 5 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => stockPg.adjust(five.id, { type: "waste", quantity: 1, reason: "race" }))
    );
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    assert.equal(succeeded.length, 5, "exactly 5 of the 10 concurrent requests for the last 5 units must win");
    assert.equal(failed.length, 5);
    for (const f of failed) assert.equal(f.reason.statusCode, 409);

    const finalStock = await getPool().query("SELECT stock_quantity FROM app.products WHERE id = $1", [five.id]);
    assert.equal(finalStock.rows[0].stock_quantity, 0, "never negative, decided by the database's own atomic conditional UPDATE");

    // balance_after correctness under concurrency: every successful movement's own stored
    // balanceAfter must be a genuine permutation of 4,3,2,1,0 - no duplicates, no skips, no
    // leftover gap - proving each movement really saw the stock AFTER its own change, never a
    // stale or duplicated value from a racing sibling.
    const balances = succeeded.map((r) => r.value.movement.balanceAfter).sort((a, b) => b - a);
    assert.deepEqual(balances, [4, 3, 2, 1, 0]);
  });

  await t.test("8. the real foreign key: a raw stock_movements insert for a non-existent product is refused by the database itself", async () => {
    await assert.rejects(
      getPool().query(
        `INSERT INTO app.stock_movements (product_id, product_name, type, quantity, balance_after)
         VALUES ('00000000-0000-0000-0000-000000000000', 'Ghost', 'adjustment', 1, 1)`
      ),
      (error) => { assert.equal(error.code, "23503"); return true; } // foreign_key_violation
    );
  });

  await t.test("9. transaction rollback: if the movement insert ever failed, the stock change itself rolls back with it", async () => {
    const cola = await freshProduct("Rollback Stock", { stockQuantity: 10 });
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE app.products SET stock_quantity = stock_quantity + 5 WHERE id = $1", [cola.id]);
        await client.query(
          `INSERT INTO app.stock_movements (product_id, product_name, type, quantity, balance_after)
           VALUES ($1, 'Rollback Stock', 'bogus_type', 5, 15)`, // invalid type -> violates the schema's own CHECK, forces a rollback
          [cola.id]
        );
      })
    );
    const stillOriginal = await getPool().query("SELECT stock_quantity FROM app.products WHERE id = $1", [cola.id]);
    assert.equal(stillOriginal.rows[0].stock_quantity, 10, "the stock UPDATE inside the failed transaction was rolled back, not partially applied");
    const noMovement = await getPool().query("SELECT count(*)::int AS n FROM app.stock_movements WHERE product_id = $1", [cola.id]);
    assert.equal(noMovement.rows[0].n, 0, "no movement row was left behind either");
  });

  await t.test("isolation: the StockMovements pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/stockMovements.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
