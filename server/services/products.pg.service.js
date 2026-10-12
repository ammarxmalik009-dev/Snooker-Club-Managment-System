// Café products - PostgreSQL pilot (Phase 2, step 2.5: a real foreign-key relationship).
// Standalone: not wired into any route, does not call and is not called by
// server/services/products.service.js (MongoDB), which stays the application's only active path.
//
// Scoped narrowly on purpose: this proves category_id's foreign key and the (category_id,
// name_key) unique constraint against the real schema (step 2.3). It does NOT port
// stock.service.js's initial-stock-movement recording, the café-tab "reserved quantity"
// calculation, or delete/history checks (StockMovement, CafeOrder, Bill) - those belong to
// their own future pilots, per the Phase 3 order in docs/POSTGRES_MIGRATION.md.

const { query } = require("../config/db.pg");
const { toMoney, toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { nameKeyOf } = require("./categories.pg.service");
const AppError = require("../utils/AppError");

function mapProductRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    name: row.name,
    categoryId: toId(row.category_id),
    price: toMoney(row.price),
    trackStock: row.track_stock,
    stockQuantity: row.stock_quantity,
    lowStockLimit: row.low_stock_limit,
    status: row.status,
    createdBy: actorFromRow(row, "created_by"),
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getProductById(id) {
  const result = await query("SELECT * FROM app.products WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Product not found", 404);
  return mapProductRow(result.rows[0]);
}

const DUPLICATE_IN_CATEGORY = "A product with this name already exists in this category";

async function createProduct(input, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const trackStock = input.trackStock !== false;
  try {
    const result = await query(
      `INSERT INTO app.products (name, name_key, category_id, price, track_stock, stock_quantity, low_stock_limit, status,
                                  created_by_user_id, created_by_name, created_by_username,
                                  updated_by_user_id, updated_by_name, updated_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $9, $10, $11)
       RETURNING *`,
      [
        input.name, nameKeyOf(input.name), input.categoryId, input.price, trackStock,
        trackStock ? (input.stockQuantity || 0) : 0, input.lowStockLimit ?? 5, input.status || "active",
        userId, actor ? actor.name : null, actor ? actor.username : null,
      ]
    );
    return mapProductRow(result.rows[0]);
  } catch (error) {
    // 23503 foreign_key_violation (category_id points at nothing) - same user-facing message and
    // status as products.service.js's own loadCategory() check, instead of a raw SQL error.
    if (error.code === "23503" && error.constraint === "products_category_id_fkey") {
      throw new AppError("Category does not exist", 400, [{ field: "categoryId", message: "Choose an existing category" }]);
    }
    // 23505 unique_violation on (category_id, name_key) - same name twice in one category.
    if (error.code === "23505") throw new AppError(DUPLICATE_IN_CATEGORY, 409, [{ field: "name", message: DUPLICATE_IN_CATEGORY }]);
    throw error;
  }
}

// Only price/status/trackStock/lowStockLimit - not name or category (those need the duplicate
// check with an excluded id, which products.service.js has but this scoped pilot doesn't need
// to prove the foreign key / unique constraint behaviour it exists for).
async function updateProductFields(id, changes) {
  const COLUMN_FOR_FIELD = { price: "price", status: "status", trackStock: "track_stock", lowStockLimit: "low_stock_limit" };
  const setClauses = [];
  const values = [];
  for (const [field, column] of Object.entries(COLUMN_FOR_FIELD)) {
    if (field in changes) { values.push(changes[field]); setClauses.push(`${column} = $${values.length}`); }
  }
  if (setClauses.length === 0) return getProductById(id);
  setClauses.push("updated_at = now()");
  values.push(id);
  const result = await query(`UPDATE app.products SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  if (result.rows.length === 0) throw new AppError("Product not found", 404);
  return mapProductRow(result.rows[0]);
}

module.exports = { getProductById, createProduct, updateProductFields, mapProductRow };
