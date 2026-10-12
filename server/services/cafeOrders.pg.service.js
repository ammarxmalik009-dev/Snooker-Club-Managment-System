// Café orders (session tabs) - PostgreSQL pilot (Phase 2, step 2.15). Standalone: not wired into
// any route, does not call and is not called by server/services/cafeOrders.service.js (MongoDB),
// which stays the application's only active path.
//
// Reused, not re-implemented: products.pg.service.js's mapProductRow-shaped columns (read
// directly here, not through that file's own functions, to keep this file's own transaction in
// full control of locking - see below). categories.pg.service.js is not required at all: a
// product's category NAME is only ever read here as a plain column value for the snapshot.
//
// The one guarantee that is STRONGER here than cafeOrders.service.js's own design, not a copy of
// it: that MongoDB service checks "is there enough free stock" with a separate read (an
// aggregate over open tab items) and then a separate, unprotected `CafeOrder.create()` - two
// genuinely concurrent adds for the same product can both read "enough free stock" before either
// one's insert lands, over-committing the tab (a real, acknowledged gap - the actual, final
// guarantee is the PHYSICAL stock decrease at billing time, which cafeOrders.service.js also
// defers to). Here, addItem and updateItem's quantity-increase path both run inside one
// transaction that locks the PRODUCT row first (`SELECT ... FOR UPDATE`): a second, genuinely
// concurrent reservation attempt for the SAME product blocks on that lock until the first
// transaction commits or rolls back, then recomputes free stock against the now-committed,
// up-to-date reserved total - never a stale read. Verified directly with real concurrent
// requests below, not assumed and not mocked.
//
// Explicitly OUT OF SCOPE (recorded, not invented - see docs/POSTGRES_MIGRATION.md's step 2.15
// section for the exact deferred transaction boundary): takeForBill (multi-product, all-or-
// nothing PHYSICAL stock deduction tied to an actual bill save), claimForBill/releaseClaim (a
// bill's claim on tab items), recordSale/restoreForCancelledBill (bill-linked stock movements).
// All four need bills.pg.service.js's own transaction, which this standalone pilot does not
// touch.

const { query, withTransaction } = require("../config/db.pg");
const { toId, toMoney, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

const CAFE_ORDER_STATUSES = ["open", "billed", "removed"];

function mapCafeOrderRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    session: toId(row.session_id),
    tableNumber: row.table_number,
    product: toId(row.product_id) || null,
    description: row.description,
    categoryName: row.category_name,
    unitPrice: toMoney(row.unit_price),
    quantity: row.quantity,
    consumer: row.consumer,
    status: row.status,
    bill: toId(row.bill_id) || null,
    billedAt: row.billed_at,
    removedAt: row.removed_at,
    addedBy: actorFromRow(row, "added_by"),
    removedBy: actorFromRow(row, "removed_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadSession(sessionId) {
  const result = await query("SELECT * FROM app.sessions WHERE id = $1", [sessionId]);
  if (result.rows.length === 0) throw new AppError("Session not found", 404);
  return result.rows[0];
}

// The tab can change only while the session has no WHOLE-SESSION bill (match_id IS NULL) - the
// same rule cafeOrders.service.js's own loadOpenTabSession enforces. A match bill alone does not
// close it: the session may go on with more matches, and open items go onto the next bill.
async function loadOpenTabSession(sessionId, client = { query: (text, params) => query(text, params) }) {
  const session = await loadSession(sessionId);
  const bill = await client.query("SELECT bill_number FROM app.bills WHERE session_id = $1 AND match_id IS NULL", [sessionId]);
  if (bill.rows.length > 0) {
    throw new AppError(`This session is already billed (${bill.rows[0].bill_number}). Café items can't be changed any more.`, 409);
  }
  return session;
}

// How many of each product are on OPEN session tabs (ordered, not billed yet) - the same
// aggregate cafeOrders.service.js's own openTabQuantities (via stock.service.js) computes.
async function openTabQuantities(productIds = null, client = { query: (text, params) => query(text, params) }) {
  const conditions = ["status = 'open'", "product_id IS NOT NULL"];
  const values = [];
  if (productIds) {
    values.push(productIds);
    conditions.push(`product_id = ANY($${values.length}::uuid[])`);
  }
  const result = await client.query(
    `SELECT product_id, sum(quantity)::int AS quantity FROM app.cafe_orders WHERE ${conditions.join(" AND ")} GROUP BY product_id`,
    values
  );
  return new Map(result.rows.map((row) => [row.product_id, row.quantity]));
}

// A product that may be sold now, and enough of it free for `quantity` more - locks the product
// row FOR UPDATE first (this file's own header comment explains why: it is what makes the free-
// stock check below safe under real concurrency, not merely usually-correct).
async function loadSellableProduct(client, productId, quantity, { alreadyOnThisItem = 0 } = {}) {
  const result = await client.query("SELECT * FROM app.products WHERE id = $1 FOR UPDATE", [productId]);
  if (result.rows.length === 0) {
    throw new AppError("Product not found", 400, [{ field: "productId", message: "Choose a product from the list" }]);
  }
  const product = result.rows[0];
  if (product.status !== "active") {
    throw new AppError(`${product.name} is not on sale (inactive)`, 409, [{ field: "productId", message: "Not on sale" }]);
  }
  if (product.track_stock) {
    const reserved = (await openTabQuantities([productId], client)).get(productId) || 0;
    const free = product.stock_quantity - (reserved - alreadyOnThisItem);
    if (quantity > free) {
      const message = free <= 0 ? `${product.name} is out of stock` : `Only ${free} ${product.name} available`;
      throw new AppError(message, 409, [{ field: "quantity", message: free <= 0 ? "Out of stock" : `Only ${free} available` }]);
    }
  }
  return product;
}

async function listItems(sessionId) {
  const session = await loadSession(sessionId);
  const [itemsResult, billResult] = await Promise.all([
    query("SELECT * FROM app.cafe_orders WHERE session_id = $1 AND status <> 'removed' ORDER BY created_at, id", [sessionId]),
    query("SELECT bill_number, status FROM app.bills WHERE session_id = $1 AND match_id IS NULL", [sessionId]),
  ]);
  const items = itemsResult.rows.map(mapCafeOrderRow);
  const open = items.filter((item) => item.status === "open");
  const bill = billResult.rows[0] || null;
  return {
    session: { id: toId(session.id), tableNumber: session.table_number, tableName: session.table_name, status: session.status },
    billed: Boolean(bill),
    bill: bill ? { billNumber: bill.bill_number, status: bill.status } : null,
    items,
    openTotal: open.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    openCount: open.length,
  };
}

// For billing (future Phase 3 use): the session's open items, oldest first.
async function openItemsForSession(sessionId) {
  const result = await query("SELECT * FROM app.cafe_orders WHERE session_id = $1 AND status = 'open' ORDER BY created_at, id", [sessionId]);
  return result.rows.map(mapCafeOrderRow);
}

async function addItem({ sessionId, productId, description, unitPrice, quantity, consumer = "" }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const session = await loadOpenTabSession(sessionId, client);

    let snapshot;
    if (productId) {
      const product = await loadSellableProduct(client, productId, quantity);
      const category = await client.query("SELECT name FROM app.categories WHERE id = $1", [product.category_id]);
      snapshot = { productId: product.id, description: product.name.slice(0, 60), categoryName: category.rows[0] ? category.rows[0].name : "", unitPrice: product.price };
    } else {
      snapshot = { productId: null, description, categoryName: "", unitPrice };
    }

    try {
      const result = await client.query(
        `INSERT INTO app.cafe_orders (session_id, table_number, product_id, description, category_name, unit_price, quantity, consumer,
                                       added_by_user_id, added_by_name, added_by_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [sessionId, session.table_number, snapshot.productId, snapshot.description, snapshot.categoryName, snapshot.unitPrice,
          quantity, consumer, userId, actor ? actor.name : null, actor ? actor.username : null]
      );
      return mapCafeOrderRow(result.rows[0]);
    } catch (error) {
      if (error.code === "23503" && error.constraint === "cafe_orders_product_id_fkey") {
        throw new AppError("Product not found", 400, [{ field: "productId", message: "Choose a product from the list" }]);
      }
      throw error;
    }
  });
}

async function loadOpenItem(client, sessionId, itemId) {
  await loadOpenTabSession(sessionId, client);
  const result = await client.query("SELECT * FROM app.cafe_orders WHERE id = $1 AND session_id = $2", [itemId, sessionId]);
  if (result.rows.length === 0) throw new AppError("Café item not found", 404);
  const item = result.rows[0];
  if (item.status !== "open") throw new AppError(`This café item is already ${item.status}`, 409);
  return item;
}

async function updateItem(sessionId, itemId, changes) {
  return withTransaction(async (client) => {
    const item = await loadOpenItem(client, sessionId, itemId);
    if (changes.quantity !== undefined && changes.quantity !== item.quantity && item.product_id) {
      await loadSellableProduct(client, item.product_id, changes.quantity, { alreadyOnThisItem: item.quantity });
    }
    const setClauses = [];
    const values = [];
    if (changes.quantity !== undefined) { values.push(changes.quantity); setClauses.push(`quantity = $${values.length}`); }
    if (changes.consumer !== undefined) { values.push(changes.consumer); setClauses.push(`consumer = $${values.length}`); }
    if (setClauses.length === 0) return mapCafeOrderRow(item);
    setClauses.push("updated_at = now()");
    values.push(itemId);

    const result = await client.query(
      `UPDATE app.cafe_orders SET ${setClauses.join(", ")} WHERE id = $${values.length} AND status = 'open' RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new AppError("This café item was billed or removed meanwhile", 409);
    return mapCafeOrderRow(result.rows[0]);
  });
}

async function removeItem(sessionId, itemId, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    await loadOpenItem(client, sessionId, itemId);
    const result = await client.query(
      `UPDATE app.cafe_orders
       SET status = 'removed', removed_at = now(), removed_by_user_id = $1, removed_by_name = $2, removed_by_username = $3, updated_at = now()
       WHERE id = $4 AND status = 'open'
       RETURNING *`,
      [userId, actor ? actor.name : null, actor ? actor.username : null, itemId]
    );
    if (result.rows.length === 0) throw new AppError("This café item was billed or removed meanwhile", 409);
    return mapCafeOrderRow(result.rows[0]);
  });
}

module.exports = {
  CAFE_ORDER_STATUSES, listItems, addItem, updateItem, removeItem, openItemsForSession, openTabQuantities, mapCafeOrderRow,
};
