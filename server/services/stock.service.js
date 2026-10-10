// Stock: every change of a product's stock goes through here.
//
// Overselling can't happen: a decrease is ONE atomic database update that only succeeds if,
// at that exact moment, the product counts stock AND has at least that many:
//    Product.findOneAndUpdate({ _id, trackStock: true, stockQuantity: { $gte: n } }, { $inc: { stockQuantity: -n } })
// Two cashiers selling the last bottle at the same moment -> one succeeds, the other gets 409.
// Each change also writes a StockMovement (history), with the stock after the change.

const mongoose = require("mongoose");
const { Product, MAX_STOCK } = require("../models/Product");
const { StockMovement } = require("../models/StockMovement");
const { CafeOrder } = require("../models/CafeOrder");
const AppError = require("../utils/AppError");
const { actorFrom } = require("../models/schemas/actor");
const env = require("../config/env");
const { startOfDayInTimeZone, startOfNextDayInTimeZone } = require("../utils/time");

// ---------- Low-level atomic changes ----------

async function increase(productId, quantity) {
  return Product.findOneAndUpdate(
    { _id: productId, trackStock: true, stockQuantity: { $lte: MAX_STOCK - quantity } },
    { $inc: { stockQuantity: quantity } },
    { returnDocument: "after" }
  );
}

async function decrease(productId, quantity) {
  return Product.findOneAndUpdate(
    { _id: productId, trackStock: true, stockQuantity: { $gte: quantity } },
    { $inc: { stockQuantity: -quantity } },
    { returnDocument: "after" }
  );
}

function movement(product, type, quantity, { reason = "", bill = null, actorUser = null } = {}) {
  return {
    product: product._id,
    productName: product.name,
    type,
    quantity,
    balanceAfter: product.stockQuantity,
    reason,
    bill: bill ? bill._id : null,
    billNumber: bill ? bill.billNumber : "",
    createdBy: actorFrom(actorUser),
  };
}

// ---------- Manual stock operations (Products page) ----------

async function loadTrackedProduct(productId) {
  const product = await Product.findById(productId);
  if (!product) throw new AppError("Product not found", 404);
  if (!product.trackStock) throw new AppError(`${product.name} is made to order: its stock isn't counted`, 409);
  return product;
}

// Goods received (admin + staff)
async function restock(productId, { quantity, reason = "" }, actorUser = null) {
  const product = await loadTrackedProduct(productId);
  const updated = await increase(product._id, quantity);
  if (!updated) {
    throw new AppError(`Stock can be at most ${MAX_STOCK.toLocaleString("en-US")}. ${product.name} has ${product.stockQuantity}.`, 409,
      [{ field: "quantity", message: "Too many" }]);
  }
  const record = await StockMovement.create(movement(updated, "restock", quantity, { reason, actorUser }));
  return { product: updated, movement: record };
}

// Corrections and write-offs (admin only). adjustment: + or -, waste: always taken off.
async function adjust(productId, { type, quantity, reason }, actorUser = null) {
  const product = await loadTrackedProduct(productId);
  const change = type === "waste" ? -Math.abs(quantity) : quantity;
  const updated = change > 0 ? await increase(product._id, change) : await decrease(product._id, -change);
  if (!updated) {
    const fresh = await Product.findById(product._id);
    throw new AppError(change < 0
      ? `Only ${fresh.stockQuantity} ${product.name} in stock - stock can't go below 0`
      : `Stock can be at most ${MAX_STOCK.toLocaleString("en-US")}`, 409, [{ field: "quantity", message: "Not possible" }]);
  }
  const record = await StockMovement.create(movement(updated, type, change, { reason, actorUser }));
  return { product: updated, movement: record };
}

// Stock entered when a product is created (part of "create product")
async function recordInitialStock(product, actorUser) {
  if (product.trackStock && product.stockQuantity > 0) {
    await StockMovement.create(movement(product, "initial", product.stockQuantity, { reason: "Stock when the product was added", actorUser }));
  }
}

// ---------- Selling on a bill ----------

// What a bill needs: { productId -> quantity } for products that count stock.
// Takes it off ALL or NOTHING: if one product runs short, what was already taken is put back.
async function takeForBill(needs) {
  const taken = [];
  for (const [productId, quantity] of needs) {
    const updated = await decrease(productId, quantity);
    if (!updated) {
      await putBack(taken);
      const product = await Product.findById(productId);
      const left = product ? product.stockQuantity : 0;
      const name = product ? product.name : "A product";
      throw new AppError(`Not enough stock: ${name} has ${left} left, this bill needs ${quantity}`, 409,
        [{ field: "cafeItems", message: `${name}: only ${left} left` }]);
    }
    taken.push({ product: updated, quantity });
  }
  return taken;
}

// Undo takeForBill (when creating the bill failed afterwards)
async function putBack(taken) {
  for (const { product, quantity } of taken) {
    await Product.updateOne({ _id: product._id }, { $inc: { stockQuantity: quantity } });
  }
}

// After the bill was saved: write the "sale" history lines
async function recordSale(taken, bill, actorUser) {
  if (taken.length === 0) return;
  await StockMovement.insertMany(taken.map(({ product, quantity }) =>
    movement(product, "sale", -quantity, { reason: `Sold on bill ${bill.billNumber}`, bill, actorUser })));
}

// A bill was cancelled before payment: put back exactly what its "sale" movements took
async function restoreForCancelledBill(bill, actorUser) {
  const sales = await StockMovement.find({ bill: bill._id, type: "sale" });
  const records = [];
  for (const sale of sales) {
    const quantity = -sale.quantity;
    // No upper-limit condition here: this only returns what the bill took
    const updated = await Product.findOneAndUpdate({ _id: sale.product }, { $inc: { stockQuantity: quantity } }, { returnDocument: "after" });
    if (updated) {
      records.push(movement(updated, "sale_reversal", quantity, { reason: `Bill ${bill.billNumber} cancelled`, bill, actorUser }));
    }
  }
  if (records.length) await StockMovement.insertMany(records);
  return records.length;
}

// ---------- Reading ----------

// How many of each product are on OPEN session tabs (ordered, not billed yet)
async function openTabQuantities(productIds = null) {
  const match = { status: "open", product: { $ne: null } };
  if (productIds) match.product = { $in: productIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
  const rows = await CafeOrder.aggregate([{ $match: match }, { $group: { _id: "$product", quantity: { $sum: "$quantity" } } }]);
  return new Map(rows.map((row) => [String(row._id), row.quantity]));
}

async function listMovements({ productId, type, from, to, page = 1, limit = 25 } = {}) {
  const filter = {};
  if (productId) filter.product = productId;
  if (type) filter.type = type;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfDayInTimeZone(from, env.clubTimeZone);
    if (to) filter.createdAt.$lt = startOfNextDayInTimeZone(to, env.clubTimeZone);
  }
  const [movements, total] = await Promise.all([
    StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    StockMovement.countDocuments(filter),
  ]);
  return { movements, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = {
  restock, adjust, recordInitialStock, takeForBill, putBack, recordSale, restoreForCancelledBill, openTabQuantities, listMovements,
};
