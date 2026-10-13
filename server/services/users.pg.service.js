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
// Step 2.8's own original scope covered create / read-by-id / read-by-username / update
// (name/role/active, with the same last-admin protection as users.service.js) and the unique
// username rule, and explicitly deferred setPassword/createFirstAdmin/resetAdminPassword.
//
// Phase 3, Group 2 (this addition) builds those three, plus listUsers/listActiveAdmins and
// touchLastLogin/getUserByUsernameForLogin (used by server/services/auth.pg.service.js's own
// login) - additive only, nothing above this comment was changed. These functions are real,
// tested PostgreSQL code. They are NOT wired into any HTTP route (server/controllers/
// users.controller.js still delegates through server/services/usersCutover.service.js's own
// selector, which only ever reaches MongoDB today - "users" is deliberately NOT in
// server/config/cutover.js's KNOWN_ROUTE_GROUPS, so there is no way to accidentally turn this
// on). createFirstAdmin/listActiveAdmins/resetAdminPassword ARE wired, directly (bypassing the
// cutover adapter on purpose, the same way the MongoDB admin scripts bypass it too), into the
// PostgreSQL-only CLI commands added in Step 32: server/scripts/createAdminPg.js and
// server/scripts/resetAdminPasswordPg.js.
//
// Historical note, since fixed (Steps 27-29): activating "users" for real HTTP traffic used to
// be blocked by an identity-format mismatch - models/schemas/actor.js's actorSchema required a
// real MongoDB ObjectId for `user`, which a PostgreSQL-authoritative user's UUID id could not
// satisfy, and every other still-MongoDB-authoritative write in the app calls
// actorFrom(req.user). actorSchema.user is now a plain `String` validated by
// `isValidActorIdentity` (ObjectId OR UUID), so this no longer blocks activation on its own -
// see docs/POSTGRES_MIGRATION.md's Phase 3 Group 2 section and Steps 33-34's audit/readiness
// write-ups for what activation still actually requires today.
//
// Session invalidation on deactivation/password change (users.service.js's own
// endAllSessionsForUser calls) is now wired in too, closing a real gap step 2.8's own pilot had
// left open (it never ended sessions on deactivation at all) - found while building this group,
// not assumed to already work.

const { query, withTransaction } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull, identityOf } = require("../db/rowMappers");
const { hashPassword, passwordProblem } = require("../utils/password"); // pure Node crypto, no mongoose
const authSessionsPg = require("./authSessions.pg.service");
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
  // identityOf, not a direct .id/._id read - found and fixed during Phase 3's own integration-
  // readiness audit: the old direct `actorUser._id` check silently evaluated to `false` for a
  // PostgreSQL-shaped actor (which has no `._id` at all), meaning this exact self-protection
  // safeguard would NOT have triggered for a PostgreSQL-authoritative admin acting on
  // themselves - a real authorization bug, not merely a missing feature. identityOf uses the
  // same "prefer .id, fall back to ._id" rule as rowMappers.js's own actorFrom, so both ends of
  // a self-comparison are read the same way regardless of which backend's actor shape it is.
  const isSelf = actorUser && String(identityOf(actorUser)) === String(id);
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

    // Deactivating logs the account out everywhere, right now - the same rule
    // users.service.js's own updateUser enforces. Inside this same transaction, so a
    // deactivation is never left half-applied (user row changed, old sessions still valid, or
    // the other way round).
    if (before.active && !after.active) {
      await authSessionsPg.endAllSessionsForUser(id, { client });
    }

    return mapUserRow(after);
  });
}

// Login only: the ONE place password_hash ever leaves the database, mirroring
// models/User.js's own select:false + the explicit .select("+passwordHash") auth.service.js's
// own login makes. Returns null (not a 404) when the username doesn't exist - the same
// "null, not an error" shape a Mongoose findOne gives, so a caller can run the SAME fakeVerify
// timing-safe fallback auth.service.js's own login does.
async function getUserByUsernameForLogin(username) {
  const normalized = normalizeUsername(username);
  const result = await query(
    `SELECT id, name, username, role, active, last_login_at, password_changed_at, password_hash,
            created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
            created_at, updated_at
     FROM app.users WHERE username = $1`,
    [normalized]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { ...mapUserRow(row), passwordHash: row.password_hash };
}

async function touchLastLogin(id, when) {
  await query("UPDATE app.users SET last_login_at = $1 WHERE id = $2", [when, id]);
}

// Admin sets a new password for a user - the same rule users.service.js's own setPassword
// enforces (password strength checked against THIS user's own username; every other login of
// theirs ends, except the admin's own current session if they changed their own password).
async function setPassword(id, password, actorUser, { currentSessionId = null } = {}) {
  const current = await getUserById(id); // 404 first, same as users.service.js
  const problem = passwordProblem(password, current.username);
  if (problem) throw new AppError(problem, 400, [{ field: "password", message: problem }]);

  const passwordHash = await hashPassword(password);
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const result = await query(
    `UPDATE app.users
     SET password_hash = $1, password_changed_at = now(), updated_by_user_id = $2, updated_by_name = $3, updated_by_username = $4, updated_at = now()
     WHERE id = $5
     RETURNING id, name, username, role, active, last_login_at, password_changed_at,
               created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
               created_at, updated_at`,
    [passwordHash, userId, actor ? actor.name : null, actor ? actor.username : null, id]
  );
  if (result.rows.length === 0) throw new AppError("User not found", 404);

  const isSelf = actorUser && String(identityOf(actorUser)) === String(id); // same identityOf rule as updateUser's own isSelf, above
  await authSessionsPg.endAllSessionsForUser(id, { exceptSessionId: isSelf ? currentSessionId : null });
  return mapUserRow(result.rows[0]);
}

// "npm run create-admin": refuses if an active admin already exists - identical rule to
// users.service.js's own createFirstAdmin. actorUser is always null here (a CLI script has no
// logged-in user), the same as the MongoDB path.
async function createFirstAdmin({ name, username, password }) {
  if ((await countActiveAdmins()) > 0) {
    throw new AppError("An active admin already exists. Log in as that admin and add users on the Users page.", 409);
  }
  return createUser({ name, username, role: "admin", password }, null);
}

// "npm run reset-admin-password": only an existing, ACTIVE admin can be reset - never creates a
// user, never touches staff/cashier accounts. Every one of that admin's logins ends.
async function listActiveAdmins() {
  const result = await query("SELECT name, username FROM app.users WHERE role = 'admin' AND active = true ORDER BY username");
  return result.rows;
}

async function resetAdminPassword(username, password) {
  const normalized = normalizeUsername(username);
  const existing = await query("SELECT id, role, active FROM app.users WHERE username = $1", [normalized]);
  if (existing.rows.length === 0 || existing.rows[0].role !== "admin") {
    throw new AppError(`There is no admin with the username "${normalized}"`, 404);
  }
  if (!existing.rows[0].active) {
    throw new AppError(`The admin "${normalized}" is deactivated. Reset the password of an active admin instead.`, 409);
  }
  const problem = passwordProblem(password, normalized);
  if (problem) throw new AppError(problem, 400, [{ field: "password", message: problem }]);

  const passwordHash = await hashPassword(password);
  const id = existing.rows[0].id;
  const result = await query(
    `UPDATE app.users
     SET password_hash = $1, password_changed_at = now(), updated_by_user_id = NULL, updated_by_name = NULL, updated_by_username = NULL, updated_at = now()
     WHERE id = $2
     RETURNING id, name, username, role, active, last_login_at, password_changed_at,
               created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
               created_at, updated_at`,
    [passwordHash, id]
  );
  await authSessionsPg.endAllSessionsForUser(id);
  return mapUserRow(result.rows[0]);
}

// The Users page's own list, with the same filters users.service.js's own listUsers accepts.
async function listUsers({ search, role, active } = {}) {
  const conditions = [];
  const values = [];
  if (role) { values.push(role); conditions.push(`role = $${values.length}`); }
  if (active !== undefined) { values.push(active); conditions.push(`active = $${values.length}`); }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(name ILIKE $${values.length} OR username ILIKE $${values.length})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query(
    `SELECT id, name, username, role, active, last_login_at, password_changed_at,
            created_by_user_id, created_by_name, created_by_username, updated_by_user_id, updated_by_name, updated_by_username,
            created_at, updated_at
     FROM app.users ${where} ORDER BY active DESC, name`,
    values
  );
  return result.rows.map(mapUserRow);
}

module.exports = {
  ROLES, createUser, getUserById, getUserByUsername, updateUser, countActiveAdmins, mapUserRow, normalizeUsername,
  getUserByUsernameForLogin, touchLastLogin, setPassword, createFirstAdmin, resetAdminPassword, listActiveAdmins, listUsers,
};
