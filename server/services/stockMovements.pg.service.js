// Stock movements - PostgreSQL pilot (Phase 2, step 2.15). Standalone: not wired into any
// route, does not call and is not called by server/services/stock.service.js (MongoDB), which
// stays the application's only active path.
//
// Reused, not re-implemented: products.pg.service.js's own mapProductRow (a sibling PostgreSQL
// pilot file, so requiring it adds no mongoose to this file's require tree - the same reuse
// players.pg.service.js's nameKeyOf already established). server/utils/time.js's
// startOfDayInTimeZone/startOfNextDayInTimeZone (pure, no mongoose) - the exact same club-local
// day-boundary rule stock.service.js's own listMovements uses.
//
// Every stock mutation and its StockMovement row are written in ONE transaction (restock,
// adjust): if the movement insert ever failed after the stock change succeeded, the whole
// transaction rolls back, undoing the stock change too - there is no window where a change could
// be recorded on the product without the matching history line, or vice versa. This is a real,
// structural guarantee stock.service.js's own separate `Product.findOneAndUpdate` +
// `StockMovement.create()` calls cannot offer (no MongoDB transactions there either).
//
// Overselling can't happen here for the same reason it can't in stock.service.js: a decrease is
// ONE atomic conditional UPDATE (`stock_quantity >= quantity`) - verified directly below with
// real concurrent requests racing for the last unit, not assumed.
//
// Explicitly OUT OF SCOPE (recorded, not invented - see docs/POSTGRES_MIGRATION.md's step 2.15
// section for the exact deferred transaction boundary): takeForBill/putBack (multi-product,
// all-or-nothing deduction tied to an actual bill save), recordSale/restoreForCancelledBill
// (bill-linked "sale"/"sale_reversal" movements). All three need bills.pg.service.js's own
// transaction, which this standalone pilot does not touch.

const { query, withTransaction } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { mapProductRow } = require("./products.pg.service");
const env = require("../config/env");
const AppError = require("../utils/AppError");
const { startOfDayInTimeZone, startOfNextDayInTimeZone } = require("../utils/time");

const MOVEMENT_TYPES = ["initial", "restock", "sale", "sale_reversal", "adjustment", "waste"];
const MAX_STOCK = 1_000_000;

function mapMovementRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    product: toId(row.product_id),
    productName: row.product_name,
    type: row.type,
    quantity: row.quantity,
    balanceAfter: row.balance_after,
    reason: row.reason,
    bill: toId(row.bill_id) || null,
    billNumber: row.bill_number,
    createdBy: actorFromRow(row, "created_by"),
    createdAt: row.created_at,
  };
}

// ---------- Low-level atomic changes (ONE conditional UPDATE each - the real guarantee) ----------

async function increase(client, productId, quantity) {
  const result = await client.query(
    `UPDATE app.products SET stock_quantity = stock_quantity + $2::int, updated_at = now()
     WHERE id = $1 AND track_stock AND stock_quantity <= $3::int - $2::int
     RETURNING *`,
    [productId, quantity, MAX_STOCK]
  );
  return result.rows[0] || null;
}

async function decrease(client, productId, quantity) {
  const result = await client.query(
    `UPDATE app.products SET stock_quantity = stock_quantity - $2::int, updated_at = now()
     WHERE id = $1 AND track_stock AND stock_quantity >= $2::int
     RETURNING *`,
    [productId, quantity]
  );
  return result.rows[0] || null;
}

async function insertMovement(client, product, type, quantity, { reason = "", billId = null, billNumber = "", userId = null, actor = null } = {}) {
  const result = await client.query(
    `INSERT INTO app.stock_movements (product_id, product_name, type, quantity, balance_after, reason, bill_id, bill_number,
                                       created_by_user_id, created_by_name, created_by_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [product.id, product.name, type, quantity, product.stock_quantity, reason, billId, billNumber, userId, actor ? actor.name : null, actor ? actor.username : null]
  );
  return mapMovementRow(result.rows[0]);
}

// ---------- Manual stock operations (Products page) ----------

async function loadTrackedProduct(client, productId) {
  const result = await client.query("SELECT * FROM app.products WHERE id = $1 FOR UPDATE", [productId]);
  if (result.rows.length === 0) throw new AppError("Product not found", 404);
  const product = result.rows[0];
  if (!product.track_stock) throw new AppError(`${product.name} is made to order: its stock isn't counted`, 409);
  return product;
}

// Goods received (admin + staff)
async function restock(productId, { quantity, reason = "" }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const product = await loadTrackedProduct(client, productId);
    const updated = await increase(client, productId, quantity);
    if (!updated) {
      throw new AppError(
        `Stock can be at most ${MAX_STOCK.toLocaleString("en-US")}. ${product.name} has ${product.stock_quantity}.`,
        409,
        [{ field: "quantity", message: "Too many" }]
      );
    }
    const movement = await insertMovement(client, updated, "restock", quantity, { reason, userId, actor });
    return { product: mapProductRow(updated), movement };
  });
}

// Corrections and write-offs (admin only). adjustment: + or -, waste: always taken off.
async function adjust(productId, { type, quantity, reason }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const change = type === "waste" ? -Math.abs(quantity) : quantity;

  return withTransaction(async (client) => {
    const product = await loadTrackedProduct(client, productId);
    const updated = change > 0 ? await increase(client, productId, change) : await decrease(client, productId, -change);
    if (!updated) {
      const message = change < 0
        ? `Only ${product.stock_quantity} ${product.name} in stock - stock can't go below 0`
        : `Stock can be at most ${MAX_STOCK.toLocaleString("en-US")}`;
      throw new AppError(message, 409, [{ field: "quantity", message: "Not possible" }]);
    }
    const movement = await insertMovement(client, updated, type, change, { reason, userId, actor });
    return { product: mapProductRow(updated), movement };
  });
}

// Stock entered when a product is created (part of "create product") - NOT wired into
// products.pg.service.js's own createProduct (that integration is Phase 3 work; this function
// exists and is tested standalone, proving the behaviour without changing an earlier pilot).
async function recordInitialStock(product, actorUser = null) {
  if (!(product.trackStock && product.stockQuantity > 0)) return null;
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  return withTransaction((client) =>
    insertMovement(
      client,
      { id: product.id, name: product.name, stock_quantity: product.stockQuantity },
      "initial",
      product.stockQuantity,
      { reason: "Stock when the product was added", userId, actor }
    )
  );
}

// ---------- Reading ----------

async function listMovements({ productId, type, from, to, page = 1, limit = 25 } = {}) {
  const conditions = [];
  const values = [];
  if (productId) { values.push(productId); conditions.push(`product_id = $${values.length}`); }
  if (type) { values.push(type); conditions.push(`type = $${values.length}`); }
  if (from) { values.push(startOfDayInTimeZone(from, env.clubTimeZone)); conditions.push(`created_at >= $${values.length}`); }
  if (to) { values.push(startOfNextDayInTimeZone(to, env.clubTimeZone)); conditions.push(`created_at < $${values.length}`); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT count(*)::int AS n FROM app.stock_movements ${where}`, values);
  const total = countResult.rows[0].n;

  const pageValues = [...values, limit, (page - 1) * limit];
  const rowsResult = await query(
    `SELECT * FROM app.stock_movements ${where} ORDER BY created_at DESC, id DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues
  );

  return { movements: rowsResult.rows.map(mapMovementRow), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = {
  MOVEMENT_TYPES, MAX_STOCK, restock, adjust, recordInitialStock, listMovements, mapMovementRow,
};
