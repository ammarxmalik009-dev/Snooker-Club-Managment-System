// Tables - PostgreSQL pilot (Phase 2, step 2.10: a model every earlier pilot has only ever
// touched as a bare fixture row, finally given its own repository). Standalone: not wired into
// any route, does not call and is not called by server/services/tables.service.js (MongoDB),
// which stays the application's only active path.
//
// app.tables has no actor columns at all (models/Table.js never recorded who created/changed a
// table either) - this pilot is simpler than Settings/Categories for that reason, not an
// oversight.

const { query } = require("../config/db.pg");
const { toId, toMoney } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

const TABLE_STATUSES = ["available", "occupied", "reserved", "maintenance"];

function mapTableRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    tableNumber: row.table_number,
    name: row.name,
    hourlyRate: toMoney(row.hourly_rate),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function duplicateError(tableNumber) {
  const message = `Table number ${tableNumber} already exists`;
  return new AppError(message, 409, [{ field: "tableNumber", message }]);
}

function validateStatus(status) {
  if (status !== undefined && !TABLE_STATUSES.includes(status)) {
    throw new AppError("Status must be one of: " + TABLE_STATUSES.join(", "), 400, [
      { field: "status", message: "Status must be one of: " + TABLE_STATUSES.join(", ") },
    ]);
  }
}

async function getTableById(id) {
  const result = await query("SELECT * FROM app.tables WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Table not found", 404);
  return mapTableRow(result.rows[0]);
}

async function getTableByNumber(tableNumber) {
  const result = await query("SELECT * FROM app.tables WHERE table_number = $1", [tableNumber]);
  return mapTableRow(result.rows[0]);
}

// Same ordering and filters tables.service.js's listTables uses: status filter, name (case
// insensitive, substring) OR exact table number if the search text is all digits.
async function listTables({ status, search } = {}) {
  const conditions = [];
  const values = [];
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (search) {
    const searchConditions = [];
    values.push(`%${search}%`);
    searchConditions.push(`name ILIKE $${values.length}`);
    if (/^\d+$/.test(search)) {
      values.push(Number(search));
      searchConditions.push(`table_number = $${values.length}`);
    }
    conditions.push(`(${searchConditions.join(" OR ")})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query(`SELECT * FROM app.tables ${where} ORDER BY table_number ASC`, values);
  return result.rows.map(mapTableRow);
}

// Same shape as tables.service.js's getTableSummary: counts grouped by status, plus a total.
async function getTableSummary() {
  const result = await query("SELECT status, count(*)::int AS count FROM app.tables GROUP BY status");
  const summary = { total: 0, available: 0, occupied: 0, reserved: 0, maintenance: 0 };
  for (const row of result.rows) {
    summary[row.status] = row.count;
    summary.total += row.count;
  }
  return summary;
}

// The database's own unique index on table_number (step 2.3) is the real, final guard against
// two tables racing to the same number - this just turns the resulting error into the same 409
// tables.service.js's own ensureTableNumberIsFree gives, instead of a raw "duplicate key" error.
async function createTable({ tableNumber, name = "", hourlyRate, status }) {
  validateStatus(status);
  try {
    const result = await query(
      `INSERT INTO app.tables (table_number, name, hourly_rate, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tableNumber, name, hourlyRate, status || "available"]
    );
    return mapTableRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw duplicateError(tableNumber); // unique_violation
    throw error;
  }
}

// "Occupied" belongs to sessions: while a session is open on this table, the status can't be
// changed by hand - same rule as tables.service.js's updateTable, checked against the real
// app.sessions table (sessions_one_open_per_table, step 2.3) rather than a Mongo count.
async function countOpenSessions(tableId) {
  const result = await query("SELECT count(*)::int AS n FROM app.sessions WHERE table_id = $1 AND is_open", [tableId]);
  return result.rows[0].n;
}

async function updateTable(id, changes) {
  validateStatus(changes.status);
  const current = await getTableById(id);

  if (changes.status !== undefined && changes.status !== current.status && (await countOpenSessions(id)) > 0) {
    throw new AppError(
      `Table ${current.tableNumber} has an active session. End the session to change its status.`,
      409,
      [{ field: "status", message: "End the active session first" }]
    );
  }

  const setClauses = [];
  const values = [];
  const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };
  if (changes.tableNumber !== undefined) setColumn("table_number", changes.tableNumber);
  if (changes.name !== undefined) setColumn("name", changes.name);
  if (changes.hourlyRate !== undefined) setColumn("hourly_rate", changes.hourlyRate);
  if (changes.status !== undefined) setColumn("status", changes.status);
  if (setClauses.length === 0) return current;
  setClauses.push("updated_at = now()");
  values.push(id);

  try {
    const result = await query(`UPDATE app.tables SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
    return mapTableRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw duplicateError(changes.tableNumber);
    throw error;
  }
}

// Pending/confirmed bookings on this table that haven't ended yet - same rule as
// tables.service.js's countUpcomingBookings.
async function countUpcomingBookings(tableId) {
  const result = await query(
    `SELECT count(*)::int AS n FROM app.bookings
     WHERE table_id = $1 AND status IN ('pending', 'confirmed') AND end_at > now()`,
    [tableId]
  );
  return result.rows[0].n;
}

// Deletion restrictions mirror tables.service.js's deleteTable exactly: occupied, an open
// session, or an upcoming booking all refuse the delete with the SAME message shape. These are
// deliberate application-level checks (giving a specific, helpful message), on top of - not
// instead of - the real foreign-key RESTRICT that app.sessions/app.bookings already impose on
// app.tables (no ON DELETE CASCADE was declared in step 2.3's schema): even if this check were
// ever skipped, the database itself would still refuse the DELETE outright (23503).
async function deleteTable(id) {
  const table = await getTableById(id);
  const label = `Table ${table.tableNumber}`;

  if (table.status === "occupied") {
    throw new AppError(`${label} is currently occupied. Free the table before deleting it.`, 409);
  }

  const openSessions = await countOpenSessions(id);
  if (openSessions > 0) {
    throw new AppError(`${label} has an active session. Stop the session before deleting the table.`, 409);
  }

  const upcomingBookings = await countUpcomingBookings(id);
  if (upcomingBookings > 0) {
    throw new AppError(
      `${label} has ${upcomingBookings} upcoming booking(s). Cancel or move them before deleting the table.`,
      409
    );
  }

  const result = await query("DELETE FROM app.tables WHERE id = $1 RETURNING *", [id]);
  return mapTableRow(result.rows[0]);
}

module.exports = {
  TABLE_STATUSES, getTableById, getTableByNumber, listTables, getTableSummary,
  createTable, updateTable, deleteTable, mapTableRow,
};
