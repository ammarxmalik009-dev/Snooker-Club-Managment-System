// Business rules for snooker tables. Controllers call these functions;
// nothing here knows about HTTP requests or responses.

const { Table } = require("../models/Table");
const { Session } = require("../models/Session");
const { Booking, ACTIVE_BOOKING_STATUSES } = require("../models/Booking");
const AppError = require("../utils/AppError");

// Makes user text safe to use inside a search pattern ("T.1" should match "T.1", not "TX1")
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Read ----------

async function listTables({ status, search } = {}) {
  const filter = {};
  if (status) filter.status = status;

  if (search) {
    // Search the name (ignoring upper/lower case) - or the exact number if the text is a number
    const conditions = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
    if (/^\d+$/.test(search)) conditions.push({ tableNumber: Number(search) });
    filter.$or = conditions;
  }

  return Table.find(filter).sort({ tableNumber: 1 });
}

// How many tables have each status - used by the dashboard cards and the page summary
async function getTableSummary() {
  const groups = await Table.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);

  const summary = { total: 0, available: 0, occupied: 0, reserved: 0, maintenance: 0 };
  for (const group of groups) {
    summary[group._id] = group.count;
    summary.total += group.count;
  }
  return summary;
}

async function getTableById(id) {
  const table = await Table.findById(id);
  if (!table) throw new AppError("Table not found", 404);
  return table;
}

// ---------- Create & update ----------

async function ensureTableNumberIsFree(tableNumber, excludeId = null) {
  const filter = { tableNumber };
  if (excludeId) filter._id = { $ne: excludeId };

  if (await Table.exists(filter)) {
    throw new AppError(`Table number ${tableNumber} already exists`, 409, [
      { field: "tableNumber", message: `Table number ${tableNumber} already exists` },
    ]);
  }
}

async function createTable(data) {
  await ensureTableNumberIsFree(data.tableNumber);
  // If two people add the same number at the exact same moment, the unique index
  // still stops the second one (the error handler turns it into a 409).
  return Table.create(data);
}

async function updateTable(id, changes) {
  const table = await getTableById(id);

  if (changes.tableNumber !== undefined && changes.tableNumber !== table.tableNumber) {
    await ensureTableNumberIsFree(changes.tableNumber, table._id);
  }

  // "Occupied" belongs to sessions: while a session runs, the status can't be changed by hand.
  // (Name, number and rate may still change - the running session keeps its own copies.)
  if (changes.status !== undefined && changes.status !== table.status && (await countOpenSessions(table._id)) > 0) {
    throw new AppError(
      `Table ${table.tableNumber} has an active session. End the session to change its status.`,
      409,
      [{ field: "status", message: "End the active session first" }]
    );
  }

  Object.assign(table, changes);
  return table.save(); // save() runs the model's validation rules again
}

// ---------- Delete (with safety checks) ----------

async function countOpenSessions(tableId) {
  return Session.countDocuments({ table: tableId, isOpen: true });
}

// Pending/confirmed bookings on this table that haven't ended yet (Phase 7 Booking model)
async function countUpcomingBookings(tableId) {
  return Booking.countDocuments({
    table: tableId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    endAt: { $gt: new Date() },
  });
}

async function deleteTable(id) {
  const table = await getTableById(id);
  const label = `Table ${table.tableNumber}`;

  if (table.status === "occupied") {
    throw new AppError(`${label} is currently occupied. Free the table before deleting it.`, 409);
  }

  const openSessions = await countOpenSessions(table._id);
  if (openSessions > 0) {
    throw new AppError(`${label} has an active session. Stop the session before deleting the table.`, 409);
  }

  const upcomingBookings = await countUpcomingBookings(table._id);
  if (upcomingBookings > 0) {
    throw new AppError(
      `${label} has ${upcomingBookings} upcoming booking(s). Cancel or move them before deleting the table.`,
      409
    );
  }

  await table.deleteOne();
  return table;
}

module.exports = { listTables, getTableSummary, getTableById, createTable, updateTable, deleteTable };
