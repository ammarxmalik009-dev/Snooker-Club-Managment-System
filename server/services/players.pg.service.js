// Players - PostgreSQL pilot (Phase 2, step 2.13). Standalone: not wired into any route, does
// not call and is not called by server/services/players.service.js (MongoDB), which stays the
// application's only active path.
//
// nameKeyOf is a small, local copy of models/Category.js's own function (the exact same
// trim + collapse-spaces + lower-case rule models/Player.js's own pre("validate") hook uses),
// not an import of it - the same isolation reason every earlier pilot's small local copies exist
// for (categories.pg.service.js's own comment explains this first).
//
// nameKey and phoneDigits are deliberately left OUT of mapPlayerRow's returned shape -
// models/Player.js's own toJSON transform strips both from every response the real app sends
// (they are internal search/uniqueness helpers, not data about the player), so this pilot
// matches that exactly rather than exposing more than the existing API does.
//
// Player history (Phase 11.6's playerHistory.service.js: Player -> Match -> Bill -> Payment) is
// explicitly OUT OF SCOPE here - it requires a real Matches repository, which has no PostgreSQL
// pilot yet (only step 2.5's fixture-only match_players/match_teams ordered-row proof exists, not
// a service). Returning a history count or total without that real join would be exactly the
// "misleading data presented as complete" this step was told not to produce - so nothing of the
// sort is implemented, and this gap is recorded as a remaining risk instead.

const { query } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

function nameKeyOf(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function phoneDigitsOf(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function mapPlayerRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    name: row.name,
    phone: row.phone,
    notes: row.notes,
    isActive: row.is_active,
    deactivatedAt: row.deactivated_at,
    createdBy: actorFromRow(row, "created_by"),
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Same length rules as players.service.js's Mongoose schema (models/Player.js's PLAYER_NAME,
// phone/notes limits) - checked here because the schema (step 2.3) has no matching CHECK
// constraint for any of these.
function validateFields({ name, phone, notes }, { nameRequired = true } = {}) {
  if (nameRequired || name !== undefined) {
    const trimmed = String(name ?? "").trim();
    if (trimmed.length < 2 || trimmed.length > 60) {
      throw new AppError("Name must be 2 to 60 characters", 400, [{ field: "name", message: "Name must be 2 to 60 characters" }]);
    }
  }
  if (phone !== undefined && String(phone).length > 20) {
    throw new AppError("Phone must be at most 20 characters", 400, [{ field: "phone", message: "Phone must be at most 20 characters" }]);
  }
  if (notes !== undefined && String(notes).length > 200) {
    throw new AppError("Notes must be at most 200 characters", 400, [{ field: "notes", message: "Notes must be at most 200 characters" }]);
  }
}

// Same pre-check players.service.js's own duplicateError makes: looks up a player with the same
// nameKey (any capitalisation/spacing), and - the one real nuance - the MESSAGE differs if that
// existing player is active vs inactive ("reactivate them instead"). This is a pre-check for a
// helpful message only; the database's own unique index on name_key (step 2.3) is the actual,
// final guard against two registrations racing for the same name (verified directly below).
async function duplicateError(name, excludeId = null) {
  const nameKey = nameKeyOf(name);
  const result = excludeId
    ? await query("SELECT name, is_active FROM app.players WHERE name_key = $1 AND id <> $2", [nameKey, excludeId])
    : await query("SELECT name, is_active FROM app.players WHERE name_key = $1", [nameKey]);
  if (result.rows.length === 0) return null;
  const existing = result.rows[0];
  const message = existing.is_active
    ? `A player called "${existing.name}" is already registered`
    : `A player called "${existing.name}" is already registered (inactive - reactivate them instead)`;
  return new AppError(message, 409, [{ field: "name", message }]);
}

async function getPlayerById(id) {
  const result = await query("SELECT * FROM app.players WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Player not found", 404);
  return mapPlayerRow(result.rows[0]);
}

async function createPlayer({ name, phone = "", notes = "" }, actorUser = null) {
  validateFields({ name, phone, notes });
  const duplicate = await duplicateError(name);
  if (duplicate) throw duplicate;

  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const trimmedName = String(name).trim();
  try {
    const result = await query(
      `INSERT INTO app.players (name, name_key, phone, phone_digits, notes,
                                 created_by_user_id, created_by_name, created_by_username,
                                 updated_by_user_id, updated_by_name, updated_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $7, $8)
       RETURNING *`,
      [trimmedName, nameKeyOf(name), phone, phoneDigitsOf(phone), notes, userId, actor ? actor.name : null, actor ? actor.username : null]
    );
    return mapPlayerRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") { // unique_violation on name_key - the database's own final guard
      throw (await duplicateError(name)) || new AppError("A player with this name is already registered", 409);
    }
    throw error;
  }
}

// Only the fields that are sent change - renaming to the same name with different capitals is
// fine (duplicateError excludes the player's own row), the same rule players.service.js enforces.
async function updatePlayer(id, changes, actorUser = null) {
  await getPlayerById(id); // 404 first, same as players.service.js
  validateFields(changes, { nameRequired: false });
  if (changes.name !== undefined) {
    const duplicate = await duplicateError(changes.name, id);
    if (duplicate) throw duplicate;
  }

  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const setClauses = [];
  const values = [];
  const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };
  if (changes.name !== undefined) {
    setColumn("name", String(changes.name).trim());
    setColumn("name_key", nameKeyOf(changes.name));
  }
  if (changes.phone !== undefined) {
    setColumn("phone", changes.phone);
    setColumn("phone_digits", phoneDigitsOf(changes.phone));
  }
  if (changes.notes !== undefined) setColumn("notes", changes.notes);
  setColumn("updated_by_user_id", userId);
  setColumn("updated_by_name", actor ? actor.name : null);
  setColumn("updated_by_username", actor ? actor.username : null);
  setClauses.push("updated_at = now()");
  values.push(id);

  try {
    const result = await query(`UPDATE app.players SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
    return mapPlayerRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw (await duplicateError(changes.name, id)) || new AppError("A player with this name is already registered", 409);
    throw error;
  }
}

// Deactivate / reactivate - never deleted, so matches and bills can always point back to a
// player (models/Player.js's own header comment). Same rule as players.service.js's setActive:
// refused with 409 if the player is already in the requested state.
async function setActive(id, active, actorUser = null) {
  const player = await getPlayerById(id);
  if (player.isActive === active) {
    throw new AppError(`${player.name} is already ${active ? "active" : "inactive"}`, 409);
  }
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const result = await query(
    `UPDATE app.players
     SET is_active = $1, deactivated_at = $2, updated_by_user_id = $3, updated_by_name = $4, updated_by_username = $5, updated_at = now()
     WHERE id = $6
     RETURNING *`,
    [active, active ? null : new Date(), userId, actor ? actor.name : null, actor ? actor.username : null, id]
  );
  return mapPlayerRow(result.rows[0]);
}

// Search by name (any part, any case) or by phone digits ("0300 12" finds "0300-1234567") - the
// same two conditions players.service.js's own searchFilter checks.
function searchConditions(search, values) {
  const conditions = [];
  values.push(`%${search}%`);
  conditions.push(`name ILIKE $${values.length}`);
  const digits = phoneDigitsOf(search);
  if (digits.length >= 3) {
    values.push(`%${digits}%`);
    conditions.push(`phone_digits ILIKE $${values.length}`);
  }
  return `(${conditions.join(" OR ")})`;
}

// Same shape as players.service.js's own listPlayers: status filter (default "active"), search,
// pagination, ordered by name_key - the same order the unique index itself is built on.
async function listPlayers({ search, status = "active", page = 1, limit = 25 } = {}) {
  const conditions = [];
  const values = [];
  if (status === "active") conditions.push("is_active = true");
  else if (status === "inactive") conditions.push("is_active = false");
  if (search) conditions.push(searchConditions(search, values));
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT count(*)::int AS n FROM app.players ${where}`, values);
  const total = countResult.rows[0].n;

  const pageValues = [...values, limit, (page - 1) * limit];
  const rowsResult = await query(
    `SELECT * FROM app.players ${where} ORDER BY name_key ASC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues
  );

  return {
    players: rowsResult.rows.map(mapPlayerRow),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  getPlayerById, createPlayer, updatePlayer, setActive, listPlayers, mapPlayerRow, nameKeyOf,
};
