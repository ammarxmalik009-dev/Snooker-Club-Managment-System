// Tests for the Categories + Products PostgreSQL pilot (Phase 2, step 2.5 - a real foreign-key
// relationship + its unique constraints - see docs/POSTGRES_MIGRATION.md). Like the other
// server/tests/postgres*.test.js files, needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A);
// SKIPPED with a clear reason otherwise. Every MongoDB test, including the real
// categories.service.js/products.service.js ones, is completely unaffected.

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

// nameKeyOf is deliberately duplicated (not imported) in categories.pg.service.js, to keep
// mongoose out of that file's require chain (see rowMappers.js). This test (not the pilot
// itself) is where the two are checked against each other, for representative inputs.
test("nameKeyOf: the PostgreSQL pilot's copy agrees with models/Category.js's own, for representative inputs", () => {
  const { nameKeyOf: pgNameKeyOf } = require("../services/categories.pg.service");
  const { nameKeyOf: mongoNameKeyOf } = require("../models/Category");
  for (const input of ["Drinks", "  Hot   Drinks  ", "SNACKS", "Café Items", ""]) {
    assert.equal(pgNameKeyOf(input), mongoNameKeyOf(input), input);
  }
});

test("PostgreSQL Categories + Products pilot: foreign keys, unique constraints, updates, nulls, rollback, isolation", { skip: skipReason }, async (t) => {
  const { getPool, withTransaction, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const categoriesPg = require("../services/categories.pg.service");
  const productsPg = require("../services/products.pg.service");

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

  let drinksId;

  await t.test("create and read: a category, then a product in it", async () => {
    const drinks = await categoriesPg.createCategory({ name: "Drinks" });
    drinksId = drinks.id;
    assert.match(drinksId, /^[0-9a-f-]{36}$/);
    assert.equal(drinks.name, "Drinks");
    assert.equal(drinks.createdBy, null);

    const cola = await productsPg.createProduct({ categoryId: drinksId, name: "Cola", price: 8000 });
    assert.equal(cola.categoryId, drinksId);
    assert.equal(cola.price, 8000);
    assert.equal(typeof cola.price, "number");
    assert.equal(cola.trackStock, true);
    assert.equal(cola.status, "active");

    const reread = await productsPg.getProductById(cola.id);
    assert.deepEqual(reread, cola);
  });

  await t.test("null/missing values: defaults match models/Product.js exactly", async () => {
    const product = await productsPg.createProduct({ categoryId: drinksId, name: "Fresh Juice", price: 15000, trackStock: false });
    assert.equal(product.trackStock, false);
    assert.equal(product.stockQuantity, 0); // not tracked -> always 0, never left over from input
    assert.equal(product.lowStockLimit, 5); // models/Product.js's DEFAULT_LOW_STOCK_LIMIT
    assert.equal(product.createdBy, null); // no actor passed
  });

  await t.test("foreign key: an unknown category is refused with the same message as products.service.js, not a raw SQL error", async () => {
    await assert.rejects(
      productsPg.createProduct({ categoryId: "00000000-0000-0000-0000-000000000000", name: "Nothing", price: 100 }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.message, "Category does not exist");
        return true;
      }
    );
  });

  await t.test("foreign key: a genuinely malformed id is refused cleanly too (not a crash)", async () => {
    await assert.rejects(productsPg.createProduct({ categoryId: "not-a-uuid-at-all", name: "Nothing", price: 100 }));
  });

  await t.test("unique constraint: the same category name twice is refused (409), case/space-insensitive", async () => {
    await assert.rejects(
      categoriesPg.createCategory({ name: "  drinks  " }),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "Category name already exists"); return true; }
    );
  });

  await t.test("unique constraint: the same product name twice in ONE category is refused; in a DIFFERENT category it's fine", async () => {
    const snacks = await categoriesPg.createCategory({ name: "Snacks" });
    await assert.rejects(
      productsPg.createProduct({ categoryId: drinksId, name: "Cola", price: 9000 }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already exists in this category/); return true; }
    );
    const colaSnack = await productsPg.createProduct({ categoryId: snacks.id, name: "Cola", price: 9000 }); // same name, different category: fine
    assert.equal(colaSnack.name, "Cola");
  });

  await t.test("updating: a category rename and a product price change are both stored and returned", async () => {
    const renamed = await categoriesPg.updateCategory(drinksId, { name: "Beverages" });
    assert.equal(renamed.name, "Beverages");
    const reread = await categoriesPg.getCategoryById(drinksId);
    assert.equal(reread.name, "Beverages");

    const products = await getPool().query("SELECT id FROM app.products WHERE category_id = $1 AND name = 'Cola'", [drinksId]);
    const updated = await productsPg.updateProductFields(products.rows[0].id, { price: 8500, status: "inactive" });
    assert.equal(updated.price, 8500);
    assert.equal(updated.status, "inactive");
  });

  await t.test("row mapping (actor direction): a real actor is stored as name/username, id null until Phase 3 (step 2.4's finding, same here)", async () => {
    const actor = { _id: "652f1c2e8a1b2c3d4e5f6071", name: "Admin Owner", username: "owner" };
    const category = await categoriesPg.createCategory({ name: "Hot Drinks" }, actor);
    assert.deepEqual(category.createdBy, { user: null, name: "Admin Owner", username: "owner" });
    assert.deepEqual(category.updatedBy, { user: null, name: "Admin Owner", username: "owner" });
  });

  await t.test("transaction rollback: a failure partway through undoes the WHOLE transaction, including the earlier insert", async () => {
    const before = await getPool().query("SELECT count(*)::int AS n FROM app.categories");
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("INSERT INTO app.categories (name, name_key) VALUES ('Rollback Test', 'rollback test')");
        // A CHECK-constraint violation (not a valid product status) - deliberately invalid
        await client.query(
          "INSERT INTO app.products (name, name_key, category_id, price, status) VALUES ('X', 'x', (SELECT id FROM app.categories WHERE name_key = 'rollback test'), 100, 'not-a-real-status')"
        );
      })
    );
    const after = await getPool().query("SELECT count(*)::int AS n FROM app.categories");
    assert.equal(after.rows[0].n, before.rows[0].n, "the category insert from the same transaction must not have survived");
    const stillThere = await getPool().query("SELECT 1 FROM app.categories WHERE name_key = 'rollback test'");
    assert.equal(stillThere.rowCount, 0);
  });

  await t.test("isolation: neither pilot service touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    for (const entry of ["../services/categories.pg.service", "../services/products.pg.service"]) {
      const ids = transitiveChildren(require.resolve(entry));
      const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
      assert.deepEqual(forbidden, [], entry);
    }
  });
});
