// Bookings - PostgreSQL pilot (Phase 2, step 2.9: the real, database-level overlap guarantee
// MongoDB cannot offer, verified against a real service for the first time - see step 2.3's
// EXCLUDE constraint, only ever tested with raw SQL before this). Standalone: not wired into any
// route, does not call and is not called by server/services/bookings.service.js (MongoDB), which
// stays the application's only active path.
//
// Overlap prevention is STRUCTURALLY different here, not a copy of the MongoDB workaround:
// bookings.service.js has no database transactions, so it does a "check before saving, save
// anyway, check again, the later id deletes itself" dance - an accepted, documented gap (its own
// comment says so). Here, the schema's `bookings_no_overlap` EXCLUDE USING gist constraint
// (step 2.3) makes an overlapping INSERT or UPDATE simply impossible at the database level -
// there is no window where two overlapping bookings can ever both exist, however briefly, and no
// "whoever loses the race deletes itself" step is needed because the losing attempt never
// succeeds in the first place.
//
// Reuses, unmodified: server/utils/time.js's zonedDateTimeToUtc (pure, no mongoose) for the same
// club-timezone date/time semantics bookings.service.js uses. ACTIVE_BOOKING_STATUSES and
// BOOKING_STATUSES are small local copies of models/Booking.js's own (not an import of that
// file, which requires "mongoose" - the same isolation reason every earlier pilot's small copies
// exist for).

const { query } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { zonedDateTimeToUtc } = require("../utils/time");
const env = require("../config/env");
const AppError = require("../utils/AppError");

const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled", "no_show"];
const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed"]; // the EXCLUDE constraint's own WHERE clause matches this exactly
const MAX_DAYS_AHEAD = 60;
const PAST_TOLERANCE_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;

function mapBookingRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    customer: toId(row.customer_id),
    table: toId(row.table_id),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    tableNumber: row.table_number,
    tableName: row.table_name,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    notes: row.notes,
    session: toId(row.session_id) || undefined,
    checkedInAt: row.checked_in_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    noShowAt: row.no_show_at,
    createdBy: actorFromRow(row, "created_by"),
    cancelledBy: actorFromRow(row, "cancelled_by"),
    checkedInBy: actorFromRow(row, "checked_in_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// "6:30 pm" in the club's timezone (for messages) - same formatting bookings.service.js uses
function clubTime(date) {
  return new Date(date).toLocaleTimeString("en-GB", { timeZone: env.clubTimeZone, hour: "numeric", minute: "2-digit", hour12: true });
}

// Same rule as bookings.service.js's resolveTimes: a club-local date+time -> UTC start/end,
// not in the past (a little tolerance), not too far ahead.
function resolveTimes({ date, startTime, durationMinutes }, { allowPast = false } = {}) {
  const startAt = zonedDateTimeToUtc(date, startTime, env.clubTimeZone);
  const endAt = new Date(startAt.getTime() + durationMinutes * MINUTE);
  const now = Date.now();
  if (!allowPast && startAt.getTime() < now - PAST_TOLERANCE_MS) {
    throw new AppError("The start time is in the past", 400, [{ field: "startTime", message: "Choose a time from now on" }]);
  }
  if (startAt.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * MINUTE) {
    throw new AppError(`Bookings can be made up to ${MAX_DAYS_AHEAD} days ahead`, 400, [{ field: "date", message: `At most ${MAX_DAYS_AHEAD} days ahead` }]);
  }
  return { startAt, endAt };
}

// Only used to build a HELPFUL error message after the database has already refused an overlap
// (the EXCLUDE constraint is what actually prevents it - this never has to be relied on for
// safety, unlike bookings.service.js's own findClash, which IS the safety mechanism there).
async function findClash(tableId, startAt, endAt, excludeId = null) {
  const result = await query(
    `SELECT * FROM app.bookings
     WHERE table_id = $1 AND status IN ('pending', 'confirmed') AND start_at < $3 AND end_at > $2
       AND ($4::uuid IS NULL OR id <> $4)
     ORDER BY id LIMIT 1`,
    [tableId, startAt, endAt, excludeId]
  );
  return result.rows[0] || null;
}

function clashError(clash) {
  const message = `Table ${clash.table_number} is already booked ${clubTime(clash.start_at)}–${clubTime(clash.end_at)} (${clash.customer_name})`;
  return new AppError(message, 409, [{ field: "startTime", message }]);
}

async function getBookingById(id) {
  const result = await query("SELECT * FROM app.bookings WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Booking not found", 404);
  return mapBookingRow(result.rows[0]);
}

async function createBooking({ customerId, tableId, customerName, customerPhone = "", tableNumber, tableName = "", startAt, endAt, status, notes = "" }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  try {
    const result = await query(
      `INSERT INTO app.bookings (customer_id, table_id, customer_name, customer_phone, table_number, table_name,
                                  start_at, end_at, status, notes, created_by_user_id, created_by_name, created_by_username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [customerId, tableId, customerName, customerPhone, tableNumber, tableName, startAt, endAt,
        status === "confirmed" ? "confirmed" : "pending", notes, userId, actor ? actor.name : null, actor ? actor.username : null]
    );
    return mapBookingRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23P01") { // exclusion_violation: the database itself refused the overlap
      const clash = await findClash(tableId, startAt, endAt);
      throw clash ? clashError(clash) : new AppError("This table is already booked for that time", 409);
    }
    if (error.code === "23503") {
      if (error.constraint === "bookings_customer_id_fkey") throw new AppError("Customer not found", 404, [{ field: "customerId", message: "Choose a customer" }]);
      throw new AppError("Table not found", 404, [{ field: "tableId", message: "Choose a table" }]);
    }
    if (error.code === "23514" && error.constraint === "bookings_end_at_check") {
      throw new AppError("The end time must be after the start time", 400, [{ field: "endAt", message: "Must be after the start time" }]);
    }
    throw error;
  }
}

// Reschedule / change table - relies on the SAME EXCLUDE constraint (it applies to UPDATE too,
// not only INSERT): no separate "check again after saving" step is needed, unlike
// bookings.service.js's updateBooking.
async function updateBooking(id, changes) {
  const current = await getBookingById(id);
  if (!ACTIVE_BOOKING_STATUSES.includes(current.status)) {
    throw new AppError(`Only pending or confirmed bookings can be changed (this one is ${current.status.replace("_", "-")})`, 409);
  }
  const setClauses = [];
  const values = [];
  const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };
  if (changes.tableId !== undefined) setColumn("table_id", changes.tableId);
  if (changes.tableNumber !== undefined) setColumn("table_number", changes.tableNumber);
  if (changes.tableName !== undefined) setColumn("table_name", changes.tableName);
  if (changes.startAt !== undefined) setColumn("start_at", changes.startAt);
  if (changes.endAt !== undefined) setColumn("end_at", changes.endAt);
  if (changes.notes !== undefined) setColumn("notes", changes.notes);
  if (setClauses.length === 0) return current;
  setClauses.push("updated_at = now()");
  values.push(id);

  try {
    const result = await query(`UPDATE app.bookings SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
    return mapBookingRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23P01") {
      const clash = await findClash(changes.tableId ?? current.table, changes.startAt ?? current.startAt, changes.endAt ?? current.endAt, id);
      throw clash ? clashError(clash) : new AppError("This table is already booked for that time", 409);
    }
    throw error;
  }
}

async function confirmBooking(id) {
  const result = await query("UPDATE app.bookings SET status = 'confirmed' WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
  if (result.rows.length > 0) return mapBookingRow(result.rows[0]);
  const existing = await getBookingById(id);
  throw new AppError(`This booking is already ${existing.status.replace("_", "-")}`, 409);
}

// Cancelling moves the booking OUT of the EXCLUDE constraint's WHERE clause (status no longer
// 'pending'/'confirmed') - the slot is freed immediately, the same outcome bookings.service.js's
// own cancel produces, just enforced by the schema's constraint rather than application logic.
async function cancelBooking(id, reason = "", actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;
  const result = await query(
    `UPDATE app.bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $1,
       cancelled_by_user_id = $2, cancelled_by_name = $3, cancelled_by_username = $4
     WHERE id = $5 AND status IN ('pending', 'confirmed') RETURNING *`,
    [reason, userId, actor ? actor.name : null, actor ? actor.username : null, id]
  );
  if (result.rows.length > 0) return mapBookingRow(result.rows[0]);
  const existing = await getBookingById(id);
  throw new AppError(`This booking is already ${existing.status.replace("_", "-")} and can't be cancelled`, 409);
}

module.exports = {
  BOOKING_STATUSES, ACTIVE_BOOKING_STATUSES, resolveTimes, getBookingById, createBooking, updateBooking,
  confirmBooking, cancelBooking, mapBookingRow, findClash,
};
