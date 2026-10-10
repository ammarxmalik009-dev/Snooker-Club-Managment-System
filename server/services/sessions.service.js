// Business rules for play sessions: start, end, list active, history.
//
// Safety without database transactions (see ARCHITECTURE.md §5.3):
//  - Starting: we "claim" the table with ONE atomic update that only succeeds if the
//    table is still available. Two staff pressing Start at the same moment -> only one wins.
//    The unique index on open sessions is a second safety net.
//  - Ending: the update only matches a session that is still open, so a session can't
//    be ended twice (e.g. double-click, or two staff at once).
//
// Billing is NOT calculated here - that is Phase 5.

const { Session } = require("../models/Session");
const { Table } = require("../models/Table");
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { actorFrom } = require("../models/schemas/actor");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, secondsBetween } = require("../utils/time");

const STATUS_REASONS = {
  occupied: "is already occupied",
  reserved: "is reserved",
  maintenance: "is under maintenance",
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Start ----------

// Step 1 of starting play: change the table to "occupied" in ONE atomic step, but only if
// its status is one of `allowedStatuses`. Returns the table as it was BEFORE (so we know
// its previous status), or throws a helpful 404/409.
async function claimTable(tableId, allowedStatuses, rule) {
  const before = await Table.findOneAndUpdate(
    { _id: tableId, status: { $in: allowedStatuses } },
    { $set: { status: "occupied" } },
    { returnDocument: "before" }
  );
  if (before) return before;

  // Find out WHY, to give a helpful message
  const existing = await Table.findById(tableId);
  if (!existing) throw new AppError("Table not found", 404);
  const reason = STATUS_REASONS[existing.status] || `is ${existing.status}`;
  throw new AppError(`Table ${existing.tableNumber} ${reason}. ${rule}`, 409);
}

// Step 2: create the session on a table we just claimed (the server's clock sets startedAt).
// If that fails, the table gets its previous status back, so it never stays "occupied" for nothing.
// Used by "Start Session" and by "Check in" of a booking (Phase 7).
async function createSessionOnClaimedTable(table, extra = {}) {
  try {
    return await Session.create({
      table: table._id,
      tableNumber: table.tableNumber,
      tableName: table.name,
      hourlyRateAtStart: table.hourlyRate,
      startedAt: new Date(),
      ...extra,
    });
  } catch (error) {
    await releaseTable(table._id, table.status);
    if (error.code === 11000) {
      throw new AppError(`Table ${table.tableNumber} already has an active session`, 409);
    }
    throw error;
  }
}

// Undo a claim: occupied -> the status it had before
async function releaseTable(tableId, previousStatus = "available") {
  await Table.updateOne({ _id: tableId, status: "occupied" }, { $set: { status: previousStatus } });
}

async function startSession(tableId, actorUser = null) {
  const table = await claimTable(tableId, ["available"], "A session can only start on an available table.");
  return createSessionOnClaimedTable(table, { startedBy: actorFrom(actorUser) });
}

// ---------- End ----------

async function endSession(sessionId, actorUser = null) {
  const session = await Session.findById(sessionId);
  if (!session) throw new AppError("Session not found", 404);
  if (!session.isOpen) {
    throw new AppError(`This session on Table ${session.tableNumber} has already ended`, 409);
  }

  const endedAt = new Date(); // server clock
  const durationSeconds = secondsBetween(session.startedAt, endedAt);

  // Only matches while the session is still open -> it can't be ended twice
  const ended = await Session.findOneAndUpdate(
    { _id: session._id, isOpen: true },
    { $set: { isOpen: false, status: "completed", endedAt, durationSeconds, endedBy: actorFrom(actorUser) } },
    { returnDocument: "after", runValidators: true }
  );
  if (!ended) {
    throw new AppError(`This session on Table ${session.tableNumber} has already ended`, 409);
  }

  // Free the table again (only if it is still marked occupied)
  await Table.updateOne({ _id: ended.table, status: "occupied" }, { $set: { status: "available" } });
  return ended;
}

// ---------- Read ----------

async function listActiveSessions() {
  return Session.find({ isOpen: true }).sort({ startedAt: 1 });
}

async function getSessionById(id) {
  const session = await Session.findById(id);
  if (!session) throw new AppError("Session not found", 404);
  return session;
}

// History with optional filters. Dates are club-local days ("2026-10-02"), inclusive.
async function listSessions({ status, from, to, search, page = 1, limit = 25 } = {}) {
  const filter = {};
  if (status) filter.status = status;

  if (from || to) {
    filter.startedAt = {};
    if (from) filter.startedAt.$gte = startOfDayInTimeZone(from, env.clubTimeZone);
    if (to) filter.startedAt.$lt = startOfNextDayInTimeZone(to, env.clubTimeZone);
  }

  if (search) {
    const conditions = [{ tableName: { $regex: escapeRegex(search), $options: "i" } }];
    if (/^\d+$/.test(search)) conditions.push({ tableNumber: Number(search) });
    filter.$or = conditions;
  }

  const [found, total] = await Promise.all([
    Session.find(filter).sort({ startedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Session.countDocuments(filter),
  ]);

  // Phase 5: add each session's bill (or null if it isn't billed yet) - one extra query for the whole page
  const { getBillsForSessions } = require("./bills.service"); // loaded here to avoid a require loop
  const { matchSummaryForSessions } = require("./matches.service");
  const ids = found.map((session) => session._id);
  const [billsBySession, matchesBySession] = await Promise.all([getBillsForSessions(ids), matchSummaryForSessions(ids)]);
  // bill    = the bill for the whole session (or null)
  // matches = Phase 11.5: how its matches stand (null = no matches) - those are billed one by one
  const sessions = found.map((session) => ({
    ...session.toJSON(),
    bill: billsBySession.get(String(session._id)) || null,
    matches: matchesBySession.get(String(session._id)) || null,
  }));

  return { sessions, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function countActiveSessions() {
  return Session.countDocuments({ isOpen: true });
}

async function hasOpenSession(tableId) {
  return Boolean(await Session.exists({ table: tableId, isOpen: true }));
}

module.exports = {
  claimTable,
  createSessionOnClaimedTable,
  releaseTable,
  startSession,
  endSession,
  listActiveSessions,
  getSessionById,
  listSessions,
  countActiveSessions,
  hasOpenSession,
};
