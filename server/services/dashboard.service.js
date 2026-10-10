// The dashboard's numbers, calculated on the server in ONE request.
// It reuses the existing services (tables, sessions, bills) instead of repeating their logic.
//
// "Today" = the club's business day in its own timezone (CLUB_TIMEZONE, Asia/Karachi):
// midnight to midnight Karachi time, using the same helpers as the date filters.
//
// Money rules:
//  - Everything is whole paisa.
//  - CANCELLED bills are not revenue: they are left out of every amount and only counted separately.
//  - "Billed / paid / outstanding today" are about bills CREATED today.
//  - "Payments received today" is the money that came in today - including payments
//    for bills from earlier days - so the cash drawer can be checked.

const { Bill } = require("../models/Bill");
const { Session } = require("../models/Session");
const reportsService = require("./reports.service");
const env = require("../config/env");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, dateInTimeZone } = require("../utils/time");
const { Booking, ACTIVE_BOOKING_STATUSES } = require("../models/Booking");
const tablesService = require("./tables.service");
const sessionsService = require("./sessions.service");
const billsService = require("./bills.service");
const bookingsService = require("./bookings.service");

const RECENT_LIMIT = 6;

// The business day as dates: "2026-10-05" -> { date, start (UTC), end (UTC, exclusive) }
function businessDay(dateText) {
  const date = dateText || dateInTimeZone(new Date(), env.clubTimeZone);
  return {
    date,
    timeZone: env.clubTimeZone,
    start: startOfDayInTimeZone(date, env.clubTimeZone),
    end: startOfNextDayInTimeZone(date, env.clubTimeZone),
  };
}

// Today's bills: totals and counts, cancelled bills kept apart.
// Phase 9: the same calculation as the Reports page (one shared definition in reports.service).
async function summarizeBills(day) {
  const t = await reportsService.summarizeBills({ createdAt: { $gte: day.start, $lt: day.end } });
  return {
    billCount: t.billCount, paidCount: t.paidCount, openCount: t.openCount, cancelledCount: t.cancelledCount,
    totalBilled: t.totalBilled, totalPaid: t.totalPaid, totalOutstanding: t.totalOutstanding,
  };
}

// Money actually received today (any bill, any day) - shared with the Reports page
async function summarizePayments(day) {
  const { amount, count } = await reportsService.summarizePayments(day);
  return { paymentsReceived: amount, paymentCount: count };
}

async function recentBills() {
  const bills = await Bill.find()
    .sort({ createdAt: -1 })
    .limit(RECENT_LIMIT)
    .select("billNumber createdAt tableNumber tableName players.name total amountPaid status");
  return bills.map((bill) => ({
    id: String(bill._id),
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    tableNumber: bill.tableNumber,
    tableName: bill.tableName,
    players: bill.players.map((player) => player.name),
    total: bill.total,
    amountPaid: bill.amountPaid,
    balanceDue: bill.status === "cancelled" ? 0 : bill.total - bill.amountPaid,
    status: bill.status,
  }));
}

async function recentSessions() {
  const sessions = await Session.find({ status: "completed" }).sort({ endedAt: -1 }).limit(RECENT_LIMIT);
  const ids = sessions.map((session) => session._id);
  const [bills, matches] = await Promise.all([
    billsService.getBillsForSessions(ids, { withDetails: true }),
    require("./matches.service").matchSummaryForSessions(ids), // Phase 11.5: sessions billed match by match
  ]);
  return sessions.map((session) => ({
    ...session.toJSON(),
    bill: bills.get(String(session._id)) || null,
    matches: matches.get(String(session._id)) || null,
  }));
}

// Phase 7: bookings that start on this business day (cancelled ones not counted)
// and the next ones still to come
async function summarizeBookings(day) {
  const [bookingCount, upcoming] = await Promise.all([
    Booking.countDocuments({ startAt: { $gte: day.start, $lt: day.end }, status: { $ne: "cancelled" } }),
    Booking.find({ status: { $in: ACTIVE_BOOKING_STATUSES }, startAt: { $lt: day.end }, endAt: { $gt: new Date() } })
      .sort({ startAt: 1 })
      .limit(RECENT_LIMIT),
  ]);
  return { bookingCount, upcoming };
}

async function getSummary({ date } = {}) {
  const day = businessDay(date);
  await bookingsService.markNoShows(); // so "upcoming" never shows a booking that is already a no-show

  const [tableCounts, tables, activeSessions, billTotals, paymentTotals, bills, sessions, bookingInfo] = await Promise.all([
    tablesService.getTableSummary(),
    tablesService.listTables(),
    sessionsService.listActiveSessions(),
    summarizeBills(day),
    summarizePayments(day),
    recentBills(),
    recentSessions(),
    summarizeBookings(day),
  ]);

  // Table overview: every table, plus its running session (if any)
  const sessionByTable = new Map(activeSessions.map((session) => [String(session.table), session]));
  const tableOverview = tables.map((table) => {
    const session = sessionByTable.get(String(table._id));
    return { ...table.toJSON(), activeSession: session ? { id: String(session._id), startedAt: session.startedAt } : null };
  });

  return {
    serverTime: new Date().toISOString(), // for the live timers
    businessDay: { date: day.date, timeZone: day.timeZone, start: day.start.toISOString(), end: day.end.toISOString() },
    tables: tableCounts,
    activeSessionCount: activeSessions.length,
    today: { ...billTotals, ...paymentTotals, bookingCount: bookingInfo.bookingCount },
    upcomingBookings: bookingInfo.upcoming,
    activeSessions,
    tableOverview,
    recentBills: bills,
    recentSessions: sessions,
  };
}

module.exports = { getSummary, businessDay };
