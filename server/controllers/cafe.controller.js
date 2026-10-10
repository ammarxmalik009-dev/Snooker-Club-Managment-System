// Thin layer between HTTP and the café services (categories, products, stock, session tabs).

const { matchedData } = require("express-validator");
const categoriesService = require("../services/categories.service");
const productsService = require("../services/products.service");
const stockService = require("../services/stock.service");
const cafeOrdersService = require("../services/cafeOrders.service");
const { sendSuccess } = require("../utils/response");

const bodyData = (req) => matchedData(req, { locations: ["body"] });
const queryData = (req) => matchedData(req, { locations: ["query"] });

// ---------- Categories ----------

async function listCategories(req, res) {
  sendSuccess(res, "Categories fetched successfully", await categoriesService.listCategories(queryData(req)));
}
async function getCategory(req, res) {
  sendSuccess(res, "Category fetched successfully", await categoriesService.getCategoryById(req.params.id));
}
async function createCategory(req, res) {
  const category = await categoriesService.createCategory(bodyData(req), req.user);
  sendSuccess(res, `Category "${category.name}" created`, category, 201);
}
async function updateCategory(req, res) {
  const category = await categoriesService.updateCategory(req.params.id, bodyData(req), req.user);
  sendSuccess(res, `Category "${category.name}" saved`, category);
}
async function deleteCategory(req, res) {
  const category = await categoriesService.deleteCategory(req.params.id);
  sendSuccess(res, `Category "${category.name}" deleted`, category);
}

// ---------- Products ----------

async function listProducts(req, res) {
  sendSuccess(res, "Products fetched successfully", await productsService.listProducts(queryData(req)));
}
async function getProduct(req, res) {
  sendSuccess(res, "Product fetched successfully", await productsService.getProductById(req.params.id));
}
async function createProduct(req, res) {
  const product = await productsService.createProduct(bodyData(req), req.user);
  sendSuccess(res, `Product "${product.name}" created`, product, 201);
}
async function updateProduct(req, res) {
  const product = await productsService.updateProduct(req.params.id, bodyData(req), req.user);
  sendSuccess(res, `Product "${product.name}" saved`, product);
}
async function deleteProduct(req, res) {
  const product = await productsService.deleteProduct(req.params.id);
  sendSuccess(res, `Product "${product.name}" deleted`, product);
}

// ---------- Stock ----------

async function restock(req, res) {
  const { product, movement } = await stockService.restock(req.params.id, bodyData(req), req.user);
  sendSuccess(res, `${product.name}: +${movement.quantity}, now ${product.stockQuantity} in stock`, { product: await productsService.getProductById(product._id), movement }, 201);
}
async function adjust(req, res) {
  const { product, movement } = await stockService.adjust(req.params.id, bodyData(req), req.user);
  const sign = movement.quantity > 0 ? "+" : "";
  sendSuccess(res, `${product.name}: ${sign}${movement.quantity}, now ${product.stockQuantity} in stock`, { product: await productsService.getProductById(product._id), movement }, 201);
}
async function listMovements(req, res) {
  sendSuccess(res, "Stock history fetched successfully", await stockService.listMovements(queryData(req)));
}
async function productMovements(req, res) {
  await productsService.getProductDocument(req.params.id); // 404 for an unknown product
  sendSuccess(res, "Stock history fetched successfully", await stockService.listMovements({ ...queryData(req), productId: req.params.id }));
}

// ---------- Session tab ----------

async function listTab(req, res) {
  sendSuccess(res, "Café tab fetched successfully", await cafeOrdersService.listItems(req.params.sessionId));
}
async function addToTab(req, res) {
  const item = await cafeOrdersService.addItem(req.params.sessionId, bodyData(req), req.user);
  sendSuccess(res, `${item.description} × ${item.quantity} added to Table ${item.tableNumber}`, item, 201);
}
async function updateTabItem(req, res) {
  const item = await cafeOrdersService.updateItem(req.params.sessionId, req.params.itemId, bodyData(req));
  sendSuccess(res, `${item.description} saved`, item);
}
async function removeTabItem(req, res) {
  const item = await cafeOrdersService.removeItem(req.params.sessionId, req.params.itemId, req.user);
  sendSuccess(res, `${item.description} removed from the tab`, item);
}

module.exports = {
  listCategories, getCategory, createCategory, updateCategory, deleteCategory,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  restock, adjust, listMovements, productMovements,
  listTab, addToTab, updateTabItem, removeTabItem,
};
