// AuthSessions - a small, independent PostgreSQL repository pilot (Phase 2, step 2.8).
//
// Deliberately minimal: create / read-by-token-hash / revoke only. This does NOT switch login,
// logout, cookies or the auth middleware to PostgreSQL - server/services/auth.service.js
// (MongoDB) is completely untouched and remains the only thing the running app's login actually
// uses. No TTL cleanup job is implemented here either (an explicit, documented exclusion, not an
// oversight): MongoDB deletes expired sessions by itself (a TTL index); PostgreSQL has no
// equivalent, and building that periodic job is left as an open item for Phase 3 (see
// docs/POSTGRES_MIGRATION.md, step 2.3's note and this step's own "remaining risks").
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

module.exports = { createSession, getSessionByTokenHash, revokeSession, mapSessionRow };
