// The café TAB of a session: items ordered while the players are playing.
// Items can be added while the session runs, and also after it ended as long as it has no bill yet.
// When the bill is created, every open item goes onto the bill (bills.service).
//
// Stock is taken off when the BILL is created, not here. But an item can only be added if
// enough is free: stock minus what is already on other open tabs. The bill does the final,
// atomic check, so stock can never go below 0 even if two tabs race for the last item.

const { CafeOrder } = require("../models/CafeOrder");
const { Session } = require("../models/Session");
const { Bill } = require("../models/Bill");
const { Category } = require("../models/Category");
const AppError = require("../utils/AppError");
const { actorFrom } = require("../models/schemas/actor");
const productsService = require("./products.service");
const stockService = require("./stock.service");

async function loadSession(sessionId) {
  const session = await Session.findById(sessionId);
  if (!session) throw new AppError("Session not found", 404);
  return session;
}

// The tab can change only while the session has no bill for the WHOLE session. Match bills
// (Phase 11.5) don't close it: the session may go on with more matches, and open items go onto
// the next bill that is made.
async function loadOpenTabSession(sessionId) {
  const session = await loadSession(sessionId);
  const bill = await Bill.findOne({ session: session._id, match: null }).select("billNumber");
  if (bill) throw new AppError(`This session is already billed (${bill.billNumber}). Café items can't be changed any more.`, 409);
  return session;
}

// A product that may be sold now, and enough of it free for `quantity` more
async function loadSellableProduct(productId, quantity, { alreadyOnThisItem = 0 } = {}) {
  const product = await productsService.getProductDocument(productId).catch(() => {
    throw new AppError("Product not found", 400, [{ field: "productId", message: "Choose a product from the list" }]);
  });
  if (product.status !== "active") throw new AppError(`${product.name} is not on sale (inactive)`, 409, [{ field: "productId", message: "Not on sale" }]);
  if (product.trackStock) {
    const reserved = (await stockService.openTabQuantities([product._id])).get(String(product._id)) || 0;
    const free = product.stockQuantity - (reserved - alreadyOnThisItem);
    if (quantity > free) {
      throw new AppError(free <= 0 ? `${product.name} is out of stock` : `Only ${free} ${product.name} available`, 409,
        [{ field: "quantity", message: free <= 0 ? "Out of stock" : `Only ${free} available` }]);
    }
  }
  return product;
}

async function listItems(sessionId) {
  const session = await loadSession(sessionId);
  const [items, bill] = await Promise.all([
    CafeOrder.find({ session: session._id, status: { $ne: "removed" } }).sort({ createdAt: 1, _id: 1 }),
    Bill.findOne({ session: session._id, match: null }).select("billNumber status"),
  ]);
  const open = items.filter((item) => item.status === "open");
  return {
    session: { id: String(session._id), tableNumber: session.tableNumber, tableName: session.tableName, status: session.status },
    billed: Boolean(bill),
    bill: bill ? { id: String(bill._id), billNumber: bill.billNumber, status: bill.status } : null,
    items,
    openTotal: open.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    openCount: open.length,
  };
}

async function addItem(sessionId, input, actorUser = null) {
  const session = await loadOpenTabSession(sessionId);
  let snapshot;
  if (input.productId) {
    const product = await loadSellableProduct(input.productId, input.quantity);
    const category = await Category.findById(product.category);
    snapshot = { product: product._id, description: product.name.slice(0, 60), categoryName: category ? category.name : "", unitPrice: product.price };
  } else {
    snapshot = { product: null, description: input.description, categoryName: "", unitPrice: input.unitPrice };
  }
  return CafeOrder.create({
    session: session._id,
    tableNumber: session.tableNumber,
    ...snapshot,
    quantity: input.quantity,
    consumer: input.consumer || "",
    addedBy: actorFrom(actorUser),
  });
}

async function loadOpenItem(sessionId, itemId) {
  await loadOpenTabSession(sessionId);
  const item = await CafeOrder.findOne({ _id: itemId, session: sessionId });
  if (!item) throw new AppError("Café item not found", 404);
  if (item.status !== "open") throw new AppError(`This café item is already ${item.status}`, 409);
  return item;
}

async function updateItem(sessionId, itemId, changes) {
  const item = await loadOpenItem(sessionId, itemId);
  if (changes.quantity !== undefined && changes.quantity !== item.quantity && item.product) {
    await loadSellableProduct(item.product, changes.quantity, { alreadyOnThisItem: item.quantity });
  }
  // Only change it if it is still open at this moment (it might have been billed meanwhile)
  const set = {};
  if (changes.quantity !== undefined) set.quantity = changes.quantity;
  if (changes.consumer !== undefined) set.consumer = changes.consumer;
  const updated = await CafeOrder.findOneAndUpdate({ _id: item._id, status: "open" }, { $set: set }, { returnDocument: "after", runValidators: true });
  if (!updated) throw new AppError("This café item was billed or removed meanwhile", 409);
  return updated;
}

async function removeItem(sessionId, itemId, actorUser = null) {
  const item = await loadOpenItem(sessionId, itemId);
  const removed = await CafeOrder.findOneAndUpdate(
    { _id: item._id, status: "open" },
    { $set: { status: "removed", removedAt: new Date(), removedBy: actorFrom(actorUser) } },
    { returnDocument: "after" }
  );
  if (!removed) throw new AppError("This café item was billed or removed meanwhile", 409);
  return removed;
}

// For billing: the session's open items
async function openItemsForSession(sessionId) {
  return CafeOrder.find({ session: sessionId, status: "open" }).sort({ createdAt: 1, _id: 1 });
}

// After the bill is saved: these items now belong to it
async function markBilled(itemIds, bill) {
  if (itemIds.length === 0) return 0;
  const result = await CafeOrder.updateMany(
    { _id: { $in: itemIds }, status: "open" },
    { $set: { status: "billed", bill: bill._id, billedAt: new Date() } }
  );
  return result.modifiedCount;
}

// Phase 11.5: claim the items for a bill BEFORE it is saved (a session can now have several bills,
// so two bills must never take the same item). Returns how many were still open and are now claimed.
async function claimForBill(itemIds, billId) {
  if (itemIds.length === 0) return 0;
  return markBilled(itemIds, { _id: billId });
}

// The bill was not saved after all: its claimed items are open again
async function releaseClaim(billId) {
  await CafeOrder.updateMany({ bill: billId, status: "billed" }, { $set: { status: "open", bill: null, billedAt: null } });
}

module.exports = { listItems, addItem, updateItem, removeItem, openItemsForSession, markBilled, claimForBill, releaseClaim, loadSellableProduct };
