// Business rules for café products (based on Malik-Snooker-Club Module 4, rebuilt for MongoDB):
//  - name 2-100 characters, unique inside its category (capital letters and spaces don't matter)
//  - category must exist; price is whole paisa (Rs 0 - Rs 100,000)
//  - stock: whole number 0 - 1,000,000; low-stock limit defaults to 5
//  - stock NEVER changes through "edit product": only through restock / adjust / sales (stock.service)
//  - a product that was ever ordered, sold or restocked can't be deleted: set it inactive instead
// Changing a product never changes old bills (bills keep copies of name, price and category).

const { Product } = require("../models/Product");
const { Category, nameKeyOf } = require("../models/Category");
const { StockMovement } = require("../models/StockMovement");
const { CafeOrder } = require("../models/CafeOrder");
const { Bill } = require("../models/Bill");
const AppError = require("../utils/AppError");
const { actorFrom } = require("../models/schemas/actor");
const stockService = require("./stock.service");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadCategory(categoryId) {
  const category = await Category.findById(categoryId);
  if (!category) throw new AppError("Category does not exist", 400, [{ field: "categoryId", message: "Choose an existing category" }]);
  return category;
}

async function ensureUniqueName(name, categoryId, excludeId = null) {
  const filter = { category: categoryId, nameKey: nameKeyOf(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Product.exists(filter)) throw duplicateError();
}

function duplicateError() {
  const message = "A product with this name already exists in this category";
  return new AppError(message, 409, [{ field: "name", message }]);
}

async function saveProduct(product) {
  try {
    return await product.save();
  } catch (error) {
    if (error.code === 11000) throw duplicateError(); // the database's unique index caught a race
    throw error;
  }
}

// The API shape: the product + its category name + what is still free to sell
function shape(product, category, reserved = 0) {
  const json = product.toJSON ? product.toJSON() : product;
  return {
    ...json,
    category: category ? { id: String(category._id), name: category.name } : null,
    reservedQuantity: product.trackStock ? reserved : 0,                                    // on open session tabs
    availableQuantity: product.trackStock ? Math.max(0, product.stockQuantity - reserved) : null, // null = not counted
  };
}

async function shapeMany(products) {
  const [categories, reserved] = await Promise.all([
    Category.find({ _id: { $in: [...new Set(products.map((p) => String(p.category)))] } }),
    stockService.openTabQuantities(products.filter((p) => p.trackStock).map((p) => p._id)),
  ]);
  const categoryById = new Map(categories.map((c) => [String(c._id), c]));
  return products.map((p) => shape(p, categoryById.get(String(p.category)), reserved.get(String(p._id)) || 0));
}

// ---------- Read ----------

async function listProducts({ search, categoryId, status, lowStock, trackStock } = {}) {
  const filter = {};
  if (search) filter.name = { $regex: escapeRegex(search.trim()), $options: "i" };
  if (categoryId) filter.category = categoryId;
  if (status && status !== "all") filter.status = status;
  if (trackStock === "true" || trackStock === "false") filter.trackStock = trackStock === "true";
  if (lowStock === "true") filter.$expr = { $and: ["$trackStock", { $lte: ["$stockQuantity", "$lowStockLimit"] }] };
  const products = await Product.find(filter).sort({ nameKey: 1 });
  return shapeMany(products);
}

async function getProductDocument(id) {
  const product = await Product.findById(id);
  if (!product) throw new AppError("Product not found", 404);
  return product;
}

async function getProductById(id) {
  return (await shapeMany([await getProductDocument(id)]))[0];
}

// ---------- Create / update / delete ----------

async function createProduct(input, actorUser = null) {
  const category = await loadCategory(input.categoryId);
  await ensureUniqueName(input.name, category._id);
  const actor = actorFrom(actorUser);
  const trackStock = input.trackStock !== false;
  const product = await saveProduct(new Product({
    name: input.name,
    category: category._id,
    price: input.price,
    trackStock,
    stockQuantity: trackStock ? input.stockQuantity || 0 : 0,
    lowStockLimit: input.lowStockLimit,
    status: input.status || "active",
    createdBy: actor,
    updatedBy: actor,
  }));
  await stockService.recordInitialStock(product, actorUser); // starting stock goes into the history too
  return getProductById(product._id);
}

// Only the fields that are sent change. Stock can't be set here (see stock.service).
async function updateProduct(id, changes, actorUser = null) {
  const product = await getProductDocument(id);
  const categoryId = changes.categoryId !== undefined ? (await loadCategory(changes.categoryId))._id : product.category;
  const name = changes.name !== undefined ? changes.name : product.name;
  if (changes.name !== undefined || changes.categoryId !== undefined) await ensureUniqueName(name, categoryId, product._id);

  product.name = name;
  product.category = categoryId;
  for (const key of ["price", "lowStockLimit", "status", "trackStock"]) {
    if (changes[key] !== undefined) product[key] = changes[key];
  }
  product.updatedBy = actorFrom(actorUser);
  await saveProduct(product);
  return getProductById(product._id);
}

// Deleting would break history, so only products that were never used can be deleted
async function deleteProduct(id) {
  const product = await getProductDocument(id);
  const [movements, orders, billLines] = await Promise.all([
    StockMovement.countDocuments({ product: product._id, type: { $ne: "initial" } }),
    CafeOrder.countDocuments({ product: product._id }),
    Bill.countDocuments({ "lineItems.product": product._id }),
  ]);
  if (movements + orders + billLines > 0) {
    throw new AppError(`${product.name} has sales or stock history, so it can't be deleted. Set it to inactive instead: it then disappears from the sale lists but keeps its history.`, 409);
  }
  await StockMovement.deleteMany({ product: product._id, type: "initial" });
  await product.deleteOne();
  return shape(product, null);
}

module.exports = { listProducts, getProductById, getProductDocument, createProduct, updateProduct, deleteProduct, shapeMany };
