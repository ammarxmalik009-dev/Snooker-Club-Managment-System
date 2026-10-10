// Business rules for café categories (based on Malik-Snooker-Club Module 3):
//  - names are trimmed, 2-100 characters, and unique without looking at capital letters
//  - a category that still has products can't be deleted
// Renaming a category never changes old bills: they keep a copy of the category name.

const { Category, nameKeyOf } = require("../models/Category");
const { Product } = require("../models/Product");
const AppError = require("../utils/AppError");
const { actorFrom } = require("../models/schemas/actor");

const DUPLICATE = "Category name already exists";

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureUnique(name, excludeId = null) {
  const filter = { nameKey: nameKeyOf(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Category.exists(filter)) throw new AppError(DUPLICATE, 409, [{ field: "name", message: DUPLICATE }]);
}

// The database's unique index is the final guard (two people adding the same name at once)
async function saveCategory(category) {
  try {
    return await category.save();
  } catch (error) {
    if (error.code === 11000) throw new AppError(DUPLICATE, 409, [{ field: "name", message: DUPLICATE }]);
    throw error;
  }
}

// Every category with how many products it has (one query for all counts)
async function listCategories({ search } = {}) {
  const filter = search ? { name: { $regex: escapeRegex(search.trim()), $options: "i" } } : {};
  const [categories, counts] = await Promise.all([
    Category.find(filter).sort({ nameKey: 1 }),
    Product.aggregate([{ $group: { _id: "$category", count: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } } } }]),
  ]);
  const byCategory = new Map(counts.map((row) => [String(row._id), row]));
  return categories.map((category) => {
    const count = byCategory.get(String(category._id));
    return { ...category.toJSON(), productCount: count ? count.count : 0, activeProductCount: count ? count.active : 0 };
  });
}

async function getCategoryById(id) {
  const category = await Category.findById(id);
  if (!category) throw new AppError("Category not found", 404);
  return category;
}

async function createCategory({ name }, actorUser = null) {
  await ensureUnique(name);
  const actor = actorFrom(actorUser);
  return saveCategory(new Category({ name, createdBy: actor, updatedBy: actor }));
}

async function updateCategory(id, { name }, actorUser = null) {
  const category = await getCategoryById(id);
  await ensureUnique(name, category._id); // "drinks" -> "Drinks" (same category) is allowed
  category.name = name;
  category.updatedBy = actorFrom(actorUser);
  return saveCategory(category);
}

async function deleteCategory(id) {
  const category = await getCategoryById(id);
  const productCount = await Product.countDocuments({ category: category._id });
  if (productCount > 0) {
    throw new AppError(
      `Cannot delete this category because it has ${productCount} product(s). Move them to another category or delete them first.`, 409);
  }
  await category.deleteOne();
  return category;
}

module.exports = { listCategories, getCategoryById, createCategory, updateCategory, deleteCategory };
