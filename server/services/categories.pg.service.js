// Café categories - PostgreSQL pilot (Phase 2, step 2.5: a real foreign-key relationship).
// Standalone: not wired into any route, does not call and is not called by
// server/services/categories.service.js (MongoDB), which stays the application's only active path.
//
// nameKeyOf is a small, local copy of models/Category.js's own function (the exact same
// trim + collapse-spaces + lower-case rule), not an import of it - importing from models/Category.js
// would pull "mongoose" into this pilot's require chain, the exact gap step 2.5 found and fixed
// in rowMappers.js's actorFrom. A test checks both functions agree on representative inputs.

const { query } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

function nameKeyOf(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

const DUPLICATE = "Category name already exists";

function mapCategoryRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    name: row.name,
    createdBy: actorFromRow(row, "created_by"),
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getCategoryById(id) {
  const result = await query("SELECT * FROM app.categories WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Category not found", 404);
  return mapCategoryRow(result.rows[0]);
}

// The database's own unique index on name_key (step 2.3) is the actual, final guard against two
// categories racing to the same name - this just turns that into the same 409 the MongoDB path
// gives, instead of a raw "duplicate key" error leaking through.
async function createCategory({ name }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  try {
    const result = await query(
      `INSERT INTO app.categories (name, name_key, created_by_user_id, created_by_name, created_by_username,
                                    updated_by_user_id, updated_by_name, updated_by_username)
       VALUES ($1, $2, $3, $4, $5, $3, $4, $5)
       RETURNING *`,
      [name, nameKeyOf(name), userId, actor ? actor.name : null, actor ? actor.username : null]
    );
    return mapCategoryRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw new AppError(DUPLICATE, 409, [{ field: "name", message: DUPLICATE }]); // unique_violation
    throw error;
  }
}

async function updateCategory(id, { name }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  try {
    const result = await query(
      `UPDATE app.categories
       SET name = $1, name_key = $2, updated_by_user_id = $3, updated_by_name = $4, updated_by_username = $5, updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [name, nameKeyOf(name), userId, actor ? actor.name : null, actor ? actor.username : null, id]
    );
    if (result.rows.length === 0) throw new AppError("Category not found", 404);
    return mapCategoryRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw new AppError(DUPLICATE, 409, [{ field: "name", message: DUPLICATE }]);
    throw error;
  }
}

module.exports = { getCategoryById, createCategory, updateCategory, mapCategoryRow, nameKeyOf };
