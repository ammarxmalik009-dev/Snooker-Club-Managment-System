// Business rules for table bookings: create, change, confirm, cancel, check in,
// automatic no-shows, day lists and availability.
//
// Times: staff enter a club-local date + time ("2026-10-07", "18:30"); the server
// converts it to UTC with the club's timezone (CLUB_TIMEZONE, Asia/Karachi).
//
// No double bookings (without database transactions):
//  1. Before saving, look for a clashing pending/confirmed booking on the same table.
//  2. After saving, look AGAIN. If two people booked the same slot at the same moment,
//     both now see each other; the one with the later id removes itself (409).
//     So exactly one booking survives.

const { Booking, ACTIVE_BOOKING_STATUSES } = require("../models/Booking");
const { Customer } = require("../models/Customer");
const { Table } = require("../models/Table");
const { Session } = require("../models/Session");
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, zonedDateTimeToUtc } = require("../utils/time");
const { getSettings } = require("./settings.service");
const { actorFrom } = require("../models/schemas/actor");
const sessionsService = require("./sessions.service");

const CHECK_IN_EARLY_MINUTES = 30;   // check-in opens 30 minutes before the start
const MAX_DAYS_AHEAD = 60;           // bookings up to 60 days ahead
const PAST_TOLERANCE_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "6:30 pm" in the club's timezone (for messages)
function clubTime(date) {
  return date.toLocaleTimeString("en-GB", { timeZone: env.clubTimeZone, hour: "numeric", minute: "2-digit", hour12: true });
}

// ---------- Automatic no-shows ----------

// Pending/confirmed bookings that started more than `grace` minutes ago without a check-in
// become "no_show". One quick database update; called before bookings are read or checked in,
// and every minute by server.js.
async function markNoShows(now = new Date()) {
  const { noShowGraceMinutes } = await getSettings();
  const cutoff = new Date(now.getTime() - noShowGraceMinutes * MINUTE);
  const result = await Booking.updateMany(
    { status: { $in: ACTIVE_BOOKING_STATUSES }, startAt: { $lte: cutoff } },
    { $set: { status: "no_show", noShowAt: now } }
  );
  return result.modifiedCount;
}

// ---------- Helpers ----------

async function getBookingById(id) {
  const booking = await Booking.findById(id);
  if (!booking) throw new AppError("Booking not found", 404);
  return booking;
}

// Turns { date, startTime, durationMinutes } into UTC start/end and checks the rules
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

async function findClash(tableId, startAt, endAt, excludeId = null) {
  const filter = {
    table: tableId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    startAt: { $lt: endAt }, // starts before we end ...
    endAt: { $gt: startAt }, // ... and ends after we start  -> overlap (touching is fine)
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Booking.findOne(filter).sort({ _id: 1 });
}

function clashError(clash) {
  const message = `Table ${clash.tableNumber} is already booked ${clubTime(clash.startAt)}–${clubTime(clash.endAt)} (${clash.customerName})`;
  return new AppError(message, 409, [{ field: "startTime", message }]);
}

async function loadTable(tableId) {
  const table = await Table.findById(tableId);
  if (!table) throw new AppError("Table not found", 404, [{ field: "tableId", message: "Choose a table" }]);
  return table;
}

// An existing customer, or a new one created from { name, phone }
async function resolveCustomer({ customerId, newCustomer }) {
  if (customerId) {
    const customer = await Customer.findById(customerId);
    if (!customer) throw new AppError("Customer not found", 404, [{ field: "customerId", message: "Choose a customer" }]);
    if (!customer.isActive) throw new AppError(`${customer.name} is archived`, 409, [{ field: "customerId", message: "This customer is archived" }]);
    return { customer, created: false };
  }
  return { customer: await Customer.create(newCustomer), created: true };
}

// ---------- Create & change ----------

async function createBooking(input, actorUser = null) {
  await markNoShows(); // an overdue booking must not block the slot
  const { startAt, endAt } = resolveTimes(input);
  const table = await loadTable(input.tableId);

  // 1. Check before saving
  const earlierClash = await findClash(table._id, startAt, endAt);
  if (earlierClash) throw clashError(earlierClash);

  const { customer, created } = await resolveCustomer(input);
  const booking = await Booking.create({
    customer: customer._id,
    table: table._id,
    customerName: customer.name,
    customerPhone: customer.phone,
    tableNumber: table.tableNumber,
    tableName: table.name,
    startAt,
    endAt,
    status: input.status === "confirmed" ? "confirmed" : "pending",
    notes: input.notes || "",
    createdBy: actorFrom(actorUser),
  });

  // 2. Check again after saving (two bookings saved at the same moment)
  const clash = await findClash(table._id, startAt, endAt, booking._id);
  if (clash && String(clash._id) < String(booking._id)) {
    await booking.deleteOne();
    if (created) await customer.deleteOne(); // don't leave a customer behind for a failed booking
    throw clashError(clash);
  }
  return booking;
}

async function updateBooking(id, changes) {
  await markNoShows();
  const booking = await getBookingById(id);
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    throw new AppError(`Only pending or confirmed bookings can be changed (this one is ${booking.status.replace("_", "-")})`, 409);
  }

  const before = { table: booking.table, tableNumber: booking.tableNumber, tableName: booking.tableName, startAt: booking.startAt, endAt: booking.endAt };

  if (changes.tableId) {
    const table = await loadTable(changes.tableId);
    Object.assign(booking, { table: table._id, tableNumber: table.tableNumber, tableName: table.name });
  }
  if (changes.date || changes.startTime || changes.durationMinutes) {
    if (!(changes.date && changes.startTime && changes.durationMinutes)) {
      throw new AppError("To change the time, send date, startTime and durationMinutes together", 400);
    }
    Object.assign(booking, resolveTimes(changes));
  }
  if (changes.notes !== undefined) booking.notes = changes.notes;

  const clash = await findClash(booking.table, booking.startAt, booking.endAt, booking._id);
  if (clash) throw clashError(clash);
  await booking.save();

  // Re-check after saving (someone else booked that slot at the same moment): undo our change
  const lateClash = await findClash(booking.table, booking.startAt, booking.endAt, booking._id);
  if (lateClash && String(lateClash._id) < String(booking._id)) {
    Object.assign(booking, before);
    await booking.save();
    throw clashError(lateClash);
  }
  return booking;
}

// ---------- Status changes ----------

async function confirmBooking(id) {
  await markNoShows();
  const booking = await Booking.findOneAndUpdate(
    { _id: id, status: "pending" },
    { $set: { status: "confirmed" } },
    { returnDocument: "after" }
  );
  if (booking) return booking;
  const existing = await getBookingById(id);
  throw new AppError(`This booking is already ${existing.status.replace("_", "-")}`, 409);
}

async function cancelBooking(id, reason = "", actorUser = null) {
  const booking = await Booking.findOneAndUpdate(
    { _id: id, status: { $in: ACTIVE_BOOKING_STATUSES } },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason, cancelledBy: actorFrom(actorUser) } },
    { returnDocument: "after" }
  );
  if (booking) return booking;
  const existing = await getBookingById(id);
  throw new AppError(`This booking is already ${existing.status.replace("_", "-")} and can't be cancelled`, 409);
}

// The customer has arrived: start the session on the booked table
async function checkInBooking(id, actorUser = null) {
  await markNoShows();
  const booking = await getBookingById(id);

  if (booking.status === "completed") throw new AppError("This booking is already checked in", 409);
  if (booking.status === "cancelled") throw new AppError("This booking was cancelled", 409);
  if (booking.status === "no_show") throw new AppError("This booking was marked as a no-show (the customer didn't arrive in time)", 409);

  const opensAt = new Date(booking.startAt.getTime() - CHECK_IN_EARLY_MINUTES * MINUTE);
  if (Date.now() < opensAt.getTime()) {
    throw new AppError(`Check-in opens at ${clubTime(opensAt)} (${CHECK_IN_EARLY_MINUTES} minutes before the booking)`, 409);
  }

  // Same steps as "Start Session" - a reserved table is fine too (it's reserved for this booking)
  const table = await sessionsService.claimTable(
    booking.table, ["available", "reserved"], "Free the table before checking in this booking."
  );
  const actor = actorFrom(actorUser);
  const session = await sessionsService.createSessionOnClaimedTable(table, { booking: booking._id, startedBy: actor });

  // Mark the booking as checked in - only if nobody else did it in the meantime
  const checkedIn = await Booking.findOneAndUpdate(
    { _id: booking._id, status: { $in: ACTIVE_BOOKING_STATUSES } },
    { $set: { status: "completed", session: session._id, checkedInAt: new Date(), checkedInBy: actor } },
    { returnDocument: "after" }
  );
  if (!checkedIn) {
    await Session.deleteOne({ _id: session._id });
    await sessionsService.releaseTable(table._id, table.status);
    throw new AppError("This booking was changed by someone else just now. Please refresh.", 409);
  }
  return { booking: checkedIn, session };
}

// ---------- Read ----------

async function listBookings({ date, from, to, status, tableId, customerId, search, page = 1, limit = 50 } = {}) {
  await markNoShows();
  const filter = {};
  const firstDay = date || from;
  const lastDay = date || to;
  if (firstDay || lastDay) {
    filter.startAt = {};
    if (firstDay) filter.startAt.$gte = startOfDayInTimeZone(firstDay, env.clubTimeZone);
    if (lastDay) filter.startAt.$lt = startOfNextDayInTimeZone(lastDay, env.clubTimeZone);
  }
  if (status === "active") filter.status = { $in: ACTIVE_BOOKING_STATUSES };
  else if (status) filter.status = status;
  if (tableId) filter.table = tableId;
  if (customerId) filter.customer = customerId;
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    const conditions = [{ customerName: pattern }, { tableName: pattern }, { customerPhone: pattern }];
    if (/^\d+$/.test(search)) conditions.push({ tableNumber: Number(search) });
    filter.$or = conditions;
  }

  // A day (or range) reads in time order; everything else newest first
  const sort = firstDay ? { startAt: 1 } : { startAt: -1 };
  const [bookings, total] = await Promise.all([
    Booking.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Booking.countDocuments(filter),
  ]);
  return { bookings, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// For the day view: every table with that day's bookings (cancelled ones left out)
async function getAvailability(date) {
  await markNoShows();
  const start = startOfDayInTimeZone(date, env.clubTimeZone);
  const end = startOfNextDayInTimeZone(date, env.clubTimeZone);

  const [tables, bookings] = await Promise.all([
    Table.find().sort({ tableNumber: 1 }),
    // Bookings that touch this day (also ones that started the evening before and run past midnight)
    Booking.find({ status: { $ne: "cancelled" }, startAt: { $lt: end }, endAt: { $gt: start } }).sort({ startAt: 1 }),
  ]);

  const byTable = new Map();
  for (const booking of bookings) {
    const key = String(booking.table);
    if (!byTable.has(key)) byTable.set(key, []);
    byTable.get(key).push(booking.toJSON());
  }
  return {
    date,
    dayStart: start.toISOString(),
    dayEnd: end.toISOString(),
    tables: tables.map((table) => ({ ...table.toJSON(), bookings: byTable.get(String(table._id)) || [] })),
  };
}

module.exports = {
  markNoShows,
  getBookingById,
  createBooking,
  updateBooking,
  confirmBooking,
  cancelBooking,
  checkInBooking,
  listBookings,
  getAvailability,
  CHECK_IN_EARLY_MINUTES,
};
