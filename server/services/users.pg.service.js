// Users - PostgreSQL pilot (Phase 2, step 2.8). Standalone: not wired into any route, does not
// call and is not called by server/services/users.service.js (MongoDB), which stays the
// application's only active path. Login, logout, cookies and the auth middleware are NOT
// touched by this file at all - see server/services/authSessions.pg.service.js for the small,
// separate session-storage pilot, which is also never wired into real login.
//
// Reuses, unmodified, the two pure pieces that already define the real security rules:
// server/utils/password.js's hashPassword/verifyPassword/passwordProblem (Node's built-in
// scrypt, no mongoose) - the EXACT SAME hashing this app already uses, not a new algorithm.
// normalizeUsername and the username format rule are small, local copies of models/User.js's
// own (not an import of that file, which requires "mongoose" to define its schema - the same
// isolation reason every earlier pilot's nameKeyOf/actorFrom copies exist for).
//
// Scope, stated up front: covers create / read-by-id / read-by-username / update
// (name/role/active, with the same last-admin protection as users.service.js) and the unique
// username rule. Does NOT implement setPassword, createFirstAdmin or resetAdminPassword - those
// are admin-password-reset-specific flows, outside this pilot's narrow goal of "establish real
// user records and the relationships other pilots need." Recorded as out of scope, not silently
// dropped - see docs/POSTGRES_MIGRATION.md.

const { query, withTransaction } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { hashPassword, passwordProblem } = require("../utils/password"); // pure Node crypto, no mongoose
const AppError = require("../utils/AppError");

const ROLES = ["admin", "staff", "cashier"]; // models/User.js's own ROLES, matched by the schema's CHECK (step 2.3)
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/; // models/User.js's own username rule

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

// password_hash is NEVER included - the one rule this mapper exists to enforce. Every row this
// pilot returns to a caller goes through this function; there is no other path out.
function mapUserRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    name: row.name,
    username: row.username,
    role: row.role,
    active: row.active,
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
    createdBy: actorFromRow(row, "created_by"),
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function countActiveAdmins(client = { query }) {
  const result = await client.query("SELECT count(*)::int AS n FROM app.users WHERE role = 'admin' AND active = true");
  return result.rows[0].n;
}

async function getUserById(id) {
  // password_hash is deliberately left out of this SELECT too - it never even leaves the
  // database for an ordinary read, not just filtered out afterward.
  const result = await query(
    "SELECT id, name, username, role, active, last_login_at, password_changed_at, created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username, created_at, updated_at FROM app.users WHERE id = $1",
    [id]
  );
  if (result.rows.length === 0) throw new AppError("User not found", 404);
  return mapUserRow(result.rows[0]);
}

async function getUserByUsername(username) {
  const normalized = normalizeUsername(username);
  const result = await query(
    "SELECT id, name, username, role, active, last_login_at, password_changed_at, created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username, created_at, updated_at FROM app.users WHERE username = $1",
    [normalized]
  );
  if (result.rows.length === 0) throw new AppError("User not found", 404);
  return mapUserRow(result.rows[0]);
}

function checkRole(role) {
  if (!ROLES.includes(role)) {
    throw new AppError(`Role must be one of: ${ROLES.join(", ")}`, 400, [{ field: "role", message: `Role must be one of: ${ROLES.join(", ")}` }]);
  }
}

function checkPassword(password, username) {
  const problem = passwordProblem(password, username);
  if (problem) throw new AppError(problem, 400, [{ field: "password", message: problem }]);
}

async function createUser({ name, username, role, password }, actorUser = null) {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AppError("Username must be 3-30 letters, numbers, dots, dashes or underscores", 400, [{ field: "username", message: "Invalid username" }]);
  }
  checkRole(role);
  checkPassword(password, normalized);

  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const passwordHash = await hashPassword(password);

  try {
    const result = await query(
      `INSERT INTO app.users (name, username, password_hash, role, created_by_user_id, created_by_name, created_by_username,
                               updated_by_user_id, updated_by_name, updated_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $6, $7)
       RETURNING id, name, username, role, active, last_login_at, password_changed_at,
                 created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
                 created_at, updated_at`,
      [name, normalized, passwordHash, role, userId, actor ? actor.name : null, actor ? actor.username : null]
    );
    return mapUserRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      throw new AppError(`The username "${normalized}" is already taken`, 409, [{ field: "username", message: "This username is already taken" }]);
    }
    throw error;
  }
}

// name / role / active, with the SAME last-admin protection as users.service.js - but using a
// real PostgreSQL transaction instead of Mongo's "save, check, revert-and-resave" compensation:
// if removing this user's admin/active status would leave zero active admins, the WHOLE
// transaction rolls back (nothing is half-applied), rather than being written then undone.
async function updateUser(id, changes, actorUser) {
  if (changes.role !== undefined) checkRole(changes.role);
  const isSelf = actorUser && String(actorUser._id) === String(id);
  if (isSelf && changes.active === false) {
    throw new AppError("You can't deactivate your own account. Ask another admin.", 409);
  }

  return withTransaction(async (client) => {
    const current = await client.query("SELECT role, active FROM app.users WHERE id = $1 FOR UPDATE", [id]);
    if (current.rows.length === 0) throw new AppError("User not found", 404);
    const before = current.rows[0];

    if (isSelf && before.role === "admin" && changes.role && changes.role !== "admin") {
      throw new AppError("You can't remove your own admin role. Ask another admin.", 409);
    }

    const actor = actorFrom(actorUser);
    const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
    const setClauses = [];
    const values = [];
    const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };
    if (changes.name !== undefined) setColumn("name", changes.name);
    if (changes.role !== undefined) setColumn("role", changes.role);
    if (changes.active !== undefined) setColumn("active", changes.active);
    setColumn("updated_by_user_id", userId);
    setColumn("updated_by_name", actor ? actor.name : null);
    setColumn("updated_by_username", actor ? actor.username : null);
    setClauses.push("updated_at = now()");
    values.push(id);

    const result = await client.query(
      `UPDATE app.users SET ${setClauses.join(", ")} WHERE id = $${values.length}
       RETURNING id, name, username, role, active, last_login_at, password_changed_at,
                 created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
                 created_at, updated_at`,
      values
    );
    const after = result.rows[0];

    // Never leave zero active admins - checked AFTER writing, inside the SAME transaction still
    // holding this row's lock, so two admins changing each other at once can't both succeed.
    const wasActiveAdmin = before.role === "admin" && before.active;
    const isActiveAdmin = after.role === "admin" && after.active;
    if (wasActiveAdmin && !isActiveAdmin) {
      const activeAdmins = await countActiveAdmins(client);
      if (activeAdmins === 0) throw new AppError("This is the last active admin. Make another user an admin first.", 409);
    }

    return mapUserRow(after);
  });
}

module.exports = { ROLES, createUser, getUserById, getUserByUsername, updateUser, countActiveAdmins, mapUserRow, normalizeUsername };
