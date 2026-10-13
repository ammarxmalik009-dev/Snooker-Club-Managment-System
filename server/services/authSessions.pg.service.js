// AuthSessions - a small, independent PostgreSQL repository pilot (Phase 2, step 2.8).
//
// Step 2.8's own original scope was deliberately minimal: create / read-by-token-hash / revoke
// only. This did NOT switch login, logout, cookies or the auth middleware to PostgreSQL -
// server/services/auth.service.js (MongoDB) stayed completely untouched.
//
// Phase 3, Group 2 (this addition) builds getValidSessionByTokenHash (expiry-checked, the real
// security-relevant read), touchLastSeen, revokeSessionByTokenHash (logout) and
// endAllSessionsForUser (session invalidation on deactivation/password change) - the pieces
// server/services/auth.pg.service.js's own login/resolveSession/logout need. These are real,
// tested PostgreSQL functions, but are NOT wired into any route - see
// server/services/auth.pg.service.js's and users.pg.service.js's own header comments, and
// docs/POSTGRES_MIGRATION.md's Phase 3 Group 2 section, for the exact, confirmed reason
// (models/schemas/actor.js's ObjectId requirement for `user`, which a PostgreSQL-authoritative
// user's UUID id cannot satisfy while anything else is still MongoDB-authoritative).
//
// No TTL cleanup job is implemented here either (an explicit, documented exclusion, not an
// oversight): MongoDB deletes expired sessions by itself (a TTL index); PostgreSQL has no
// equivalent. getValidSessionByTokenHash filters expired sessions out of its own read
// regardless (the same real security check auth.service.js's own resolveSession makes - TTL
// cleanup is a housekeeping convenience, never the actual security boundary, in EITHER
// database), so this gap is about reclaiming storage, not about safety.
//
// app.auth_sessions.user_id is NOT NULL (step 2.3) - unlike every other *_user_id column in this
// schema (all nullable "who did it" copies), a session genuinely cannot exist without a real
// user row to reference. This pilot is what actually proves that FK against a real user for the
// first time (step 2.7's Payments pilot could only ever store null there, since no real user
// existed yet).

const { query } = require("../config/db.pg");
const { toId } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    tokenHash: row.token_hash,
    user: toId(row.user_id),
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createSession({ userId, tokenHash, expiresAt, userAgent = "", ip = "" }) {
  try {
    const result = await query(
      `INSERT INTO app.auth_sessions (user_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, tokenHash, expiresAt, userAgent.slice(0, 300), ip.slice(0, 64)]
    );
    return mapSessionRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23503") throw new AppError("User does not exist", 400, [{ field: "userId", message: "Choose an existing user" }]);
    if (error.code === "23505") throw new AppError("This session token already exists", 409);
    throw error;
  }
}

async function getSessionByTokenHash(tokenHash) {
  const result = await query("SELECT * FROM app.auth_sessions WHERE token_hash = $1", [tokenHash]);
  return mapSessionRow(result.rows[0]);
}

async function revokeSession(id) {
  const result = await query("DELETE FROM app.auth_sessions WHERE id = $1 RETURNING *", [id]);
  return mapSessionRow(result.rows[0]);
}

// The real security-relevant read: only a session that is BOTH present AND not yet expired
// counts as valid - the same check auth.service.js's own resolveSession makes with
// `expiresAt: { $gt: new Date() }`, just as a WHERE clause instead of a query filter.
async function getValidSessionByTokenHash(tokenHash) {
  const result = await query("SELECT * FROM app.auth_sessions WHERE token_hash = $1 AND expires_at > now()", [tokenHash]);
  return mapSessionRow(result.rows[0]);
}

// Logout: deletes by token hash regardless of expiry (an already-expired cookie's session row,
// if it somehow still exists, is removed too) - the same unconditional delete
// auth.service.js's own logout makes.
async function revokeSessionByTokenHash(tokenHash) {
  const result = await query("DELETE FROM app.auth_sessions WHERE token_hash = $1 RETURNING *", [tokenHash]);
  return mapSessionRow(result.rows[0]);
}

async function touchLastSeen(id, when) {
  await query("UPDATE app.auth_sessions SET last_seen_at = $1 WHERE id = $2", [when, id]);
}

// Log a user out everywhere (deactivation, a password change) - or everywhere EXCEPT the
// session making the change itself (an admin changing their own password stays logged in on
// their own current session), the same two cases users.service.js's own calls need. Accepts an
// optional transaction-scoped client (e.g. users.pg.service.js's own updateUser, which must
// never leave a user deactivated with their old sessions still valid, even if the rest of that
// same transaction later fails) - the same optional-client pattern step 2.16's counters pilot
// established, not a new convention.
async function endAllSessionsForUser(userId, { exceptSessionId = null, client } = {}) {
  const runner = client || { query: (text, params) => query(text, params) };
  if (exceptSessionId) {
    await runner.query("DELETE FROM app.auth_sessions WHERE user_id = $1 AND id <> $2", [userId, exceptSessionId]);
  } else {
    await runner.query("DELETE FROM app.auth_sessions WHERE user_id = $1", [userId]);
  }
}

module.exports = {
  createSession, getSessionByTokenHash, getValidSessionByTokenHash, revokeSession,
  revokeSessionByTokenHash, touchLastSeen, endAllSessionsForUser, mapSessionRow,
};
