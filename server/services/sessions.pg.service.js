// Sessions - PostgreSQL pilot (Phase 2, step 2.12: the real multi-statement transaction
// MongoDB's sessions.service.js cannot have). Standalone: not wired into any route, does not
// call and is not called by server/services/sessions.service.js (MongoDB), which stays the
// application's only active path.
//
// How starting a session is actually safer here, not a copy of the MongoDB workaround:
// sessions.service.js has no database transactions, so starting is a documented two-step dance -
// claim the table with one atomic conditional UPDATE, create the session, and if THAT insert
// fails (the unique-open-session index as a safety net), manually release the table back to its
// previous status as a SEPARATE compensating step. Here, claiming the table and creating the
// session happen inside ONE real PostgreSQL transaction (withTransaction): if the INSERT fails
// for any reason (including the sessions_one_open_per_table unique partial index, step 2.3), the
// table's UPDATE is rolled back automatically along with it - no manual "release" step exists or
// is needed, because there is no window where the table could be left claimed without a session.
//
// Reused, unmodified: server/utils/time.js's secondsBetween/startOfDayInTimeZone/
// startOfNextDayInTimeZone (pure, no mongoose) - the exact same duration and club-local day
// boundary rules sessions.service.js itself uses.
//
// Explicitly out of scope (recorded, not invented): listSessions's own bill/match joins
// (sessions.service.js loads server/services/bills.service.js and matches.service.js for this -
// neither has a PostgreSQL pilot yet, and pulling either in here would be well beyond this
// step's narrow goal). This pilot's listSessions returns sessions only, without bill/matches.

const { query, withTransaction } = require("../config/db.pg");
const { toId, toMoney, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const env = require("../config/env");
const AppError = require("../utils/AppError");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, secondsBetween } = require("../utils/time");

const SESSION_STATUSES = ["active", "completed"];

const STATUS_REASONS = {
  occupied: "is already occupied",
  reserved: "is reserved",
  maintenance: "is under maintenance",
};

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    table: toId(row.table_id),
    tableNumber: row.table_number,
    tableName: row.table_name,
    hourlyRateAtStart: toMoney(row.hourly_rate_at_start),
    booking: toId(row.booking_id) || undefined,
    status: row.status,
    isOpen: row.is_open,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    startedBy: actorFromRow(row, "started_by"),
    endedBy: actorFromRow(row, "ended_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSessionById(id) {
  const result = await query("SELECT * FROM app.sessions WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Session not found", 404);
  return mapSessionRow(result.rows[0]);
}

// Start a session: claim the table (only if "available") and create the session in ONE
// transaction - see this file's own header comment for how this differs from
// sessions.service.js's two-step, non-transactional dance.
async function startSession({ tableId }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const tableResult = await client.query(
      `UPDATE app.tables SET status = 'occupied' WHERE id = $1 AND status = 'available' RETURNING *`,
      [tableId]
    );
    if (tableResult.rows.length === 0) {
      const existing = await client.query("SELECT * FROM app.tables WHERE id = $1", [tableId]);
      if (existing.rows.length === 0) throw new AppError("Table not found", 404);
      const table = existing.rows[0];
      const reason = STATUS_REASONS[table.status] || `is ${table.status}`;
      throw new AppError(`Table ${table.table_number} ${reason}. A session can only start on an available table.`, 409);
    }
    const table = tableResult.rows[0];

    try {
      const sessionResult = await client.query(
        `INSERT INTO app.sessions (table_id, table_number, table_name, hourly_rate_at_start,
                                    started_by_user_id, started_by_name, started_by_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [tableId, table.table_number, table.name, table.hourly_rate, userId, actor ? actor.name : null, actor ? actor.username : null]
      );
      return mapSessionRow(sessionResult.rows[0]);
    } catch (error) {
      if (error.code === "23505") { // sessions_one_open_per_table - the safety net, same as sessions.service.js's own comment
        throw new AppError(`Table ${table.table_number} already has an active session`, 409);
      }
      throw error;
    }
  });
}

// End a session: only matches while still open (can't be ended twice), computes the real
// duration with the server's own clock, and frees the table back to "available" - all inside
// one transaction, so a session is never left "ended" with the table still stuck "occupied", or
// vice versa.
async function endSession(sessionId, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM app.sessions WHERE id = $1", [sessionId]);
    if (current.rows.length === 0) throw new AppError("Session not found", 404);
    if (!current.rows[0].is_open) {
      throw new AppError(`This session on Table ${current.rows[0].table_number} has already ended`, 409);
    }

    const endedAt = new Date();
    const durationSeconds = secondsBetween(current.rows[0].started_at, endedAt);

    const result = await client.query(
      `UPDATE app.sessions
       SET is_open = false, status = 'completed', ended_at = $1, duration_seconds = $2,
           ended_by_user_id = $3, ended_by_name = $4, ended_by_username = $5, updated_at = now()
       WHERE id = $6 AND is_open = true
       RETURNING *`,
      [endedAt, durationSeconds, userId, actor ? actor.name : null, actor ? actor.username : null, sessionId]
    );
    if (result.rows.length === 0) {
      throw new AppError(`This session on Table ${current.rows[0].table_number} has already ended`, 409);
    }
    const ended = result.rows[0];
    await client.query("UPDATE app.tables SET status = 'available' WHERE id = $1 AND status = 'occupied'", [ended.table_id]);
    return mapSessionRow(ended);
  });
}

async function listActiveSessions() {
  const result = await query("SELECT * FROM app.sessions WHERE is_open ORDER BY started_at ASC");
  return result.rows.map(mapSessionRow);
}

async function countActiveSessions() {
  const result = await query("SELECT count(*)::int AS n FROM app.sessions WHERE is_open");
  return result.rows[0].n;
}

async function hasOpenSession(tableId) {
  const result = await query("SELECT 1 FROM app.sessions WHERE table_id = $1 AND is_open", [tableId]);
  return result.rows.length > 0;
}

// History with optional filters - same rules as sessions.service.js's own listSessions (status,
// club-local day range, table name/number search), minus the bill/match joins (out of scope,
// see this file's own header comment).
async function listSessions({ status, from, to, search, page = 1, limit = 25 } = {}) {
  const conditions = [];
  const values = [];
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (from) {
    values.push(startOfDayInTimeZone(from, env.clubTimeZone));
    conditions.push(`started_at >= $${values.length}`);
  }
  if (to) {
    values.push(startOfNextDayInTimeZone(to, env.clubTimeZone));
    conditions.push(`started_at < $${values.length}`);
  }
  if (search) {
    const searchConditions = [];
    values.push(`%${search}%`);
    searchConditions.push(`table_name ILIKE $${values.length}`);
    if (/^\d+$/.test(search)) {
      values.push(Number(search));
      searchConditions.push(`table_number = $${values.length}`);
    }
    conditions.push(`(${searchConditions.join(" OR ")})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query(`SELECT count(*)::int AS n FROM app.sessions ${where}`, values);
  const total = countResult.rows[0].n;

  const pageValues = [...values, limit, (page - 1) * limit];
  const rowsResult = await query(
    `SELECT * FROM app.sessions ${where} ORDER BY started_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues
  );

  return {
    sessions: rowsResult.rows.map(mapSessionRow),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  SESSION_STATUSES, getSessionById, startSession, endSession, listActiveSessions,
  countActiveSessions, hasOpenSession, listSessions, mapSessionRow,
};
