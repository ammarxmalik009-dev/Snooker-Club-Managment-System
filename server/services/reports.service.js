// Reports (Phase 9): business figures for a period, calculated by MongoDB on the server.
//
// Ground rules (also in docs/API.md, "Reports"):
//  - Periods are CLUB days (Asia/Karachi): "1-5 Oct" = 1 Oct 00:00 to 6 Oct 00:00 Karachi time.
//  - Money is whole paisa everywhere. Amounts come from what was SAVED on each bill
//    (total, amountPaid) - old bills are never re-priced with today's Settings.
//  - Cancelled bills are never revenue. They are only counted, separately.
//  - A bill belongs to the day it was CREATED; a payment to the day it was RECEIVED.
//  - Payments come from the real "payments" collection, never guessed from bill status.
//  - Every total is an aggregation inside MongoDB ($match -> $group). Only the finished
//    numbers come back to Node, never all the bills / payments / sessions.

const mongoose = require("mongoose");
const env = require("../config/env");
const { Bill, BILL_STATUSES } = require("../models/Bill");
const { ALL_GAME_MODE_KEYS } = require("../config/gameModes");
const { Match } = require("../models/Match");
const { Player } = require("../models/Player");
const { matchStatsStages, billSummaryStages, EMPTY_MATCH_STATS, EMPTY_BILL_SUMMARY } = require("./playerHistory.service");
const { Payment, PAYMENT_METHODS } = require("../models/Payment");
const { Session, SESSION_STATUSES } = require("../models/Session");
const { Booking, BOOKING_STATUSES } = require("../models/Booking");
const { Customer } = require("../models/Customer");
const { Table } = require("../models/Table");
const AppError = require("../utils/AppError");
const { toCsv, paisaToRupees } = require("../utils/csv");
const {
  startOfDayInTimeZone, startOfNextDayInTimeZone, dateInTimeZone, shiftDate, daysInRange, formatInTimeZone,
} = require("../utils/time");
const bookingsService = require("./bookings.service");

const PRESETS = ["today", "yesterday", "last7", "last30", "thisMonth", "prevMonth"];
const DEFAULT_PRESET = "last7";
const MAX_RANGE_DAYS = 366;
const TABLE_SORTS = ["revenue", "sessions", "billedTime", "tableNumber"];
const OUTSTANDING_SORTS = ["oldest", "newest", "balance"];
const MATCH_SORTS = ["newest", "oldest"];                                  // Phase 11.7
const PLAYER_SORTS = ["matches", "wins", "billed", "outstanding", "name"];   // Phase 11.7
const REPORT_PAGE_SIZE = 25;                                                // rows per screen page (Matches, Players)
const EXPORTS = ["revenue", "payments", "games", "matches", "players", "tables", "bookings", "outstanding"];
const EXPORT_MAX_ROWS = 50_000; // a CSV bigger than this would be unusable - ask for a shorter period
// Printing every outstanding bill: 2,000 rows is roughly 60-80 printed pages. More than that isn't a
// useful paper report (and would slow the browser), so the page asks to narrow the filters or use CSV.
const PRINT_MAX_ROWS = 2_000;
const TOP_CUSTOMERS = 10;
const OPEN_STATUSES = ["unpaid", "partially_paid"];

// =====================================================================
// Period and filters
// =====================================================================

// { preset: "last7" } or { from: "2026-10-01", to: "2026-10-05" } -> the exact UTC window.
// "now" decides what "today" is - in the CLUB's timezone, never the browser's.
function resolveRange({ preset, from, to } = {}, now = new Date()) {
  const timeZone = env.clubTimeZone;
  const today = dateInTimeZone(now, timeZone);
  let chosen = preset || DEFAULT_PRESET;

  if (from && to) {
    chosen = "custom";
  } else if (chosen === "today") {
    from = today; to = today;
  } else if (chosen === "yesterday") {
    from = shiftDate(today, -1); to = from;
  } else if (chosen === "last7") {
    from = shiftDate(today, -6); to = today; // 7 days including today
  } else if (chosen === "last30") {
    from = shiftDate(today, -29); to = today;
  } else if (chosen === "thisMonth") {
    from = `${today.slice(0, 7)}-01`; to = today; // month so far
  } else if (chosen === "prevMonth") {
    to = shiftDate(`${today.slice(0, 7)}-01`, -1); // last day of the previous month
    from = `${to.slice(0, 7)}-01`;
  } else {
    throw new AppError(`Unknown period "${chosen}"`, 400);
  }

  const days = daysInRange(from, to);
  if (days < 1) throw new AppError("To date cannot be before the From date", 400);
  if (days > MAX_RANGE_DAYS) throw new AppError(`Choose a period of at most ${MAX_RANGE_DAYS} days`, 400);

  return {
    preset: chosen,
    from,
    to,
    days,
    timeZone,
    start: startOfDayInTimeZone(from, timeZone),  // first moment (UTC)
    end: startOfNextDayInTimeZone(to, timeZone),  // exclusive end (UTC): the next day's 00:00
  };
}

// The optional filters, checked by the validators. Unused ones are null.
function readFilters(query = {}) {
  return {
    tableId: query.tableId ? new mongoose.Types.ObjectId(query.tableId) : null,
    gameMode: query.gameMode || null,
    method: query.method || null,
    billStatus: query.billStatus || null,
    bookingStatus: query.bookingStatus || null,
  };
}

// What goes back to the browser about the period (dates as text, moments as ISO)
function rangeInfo(range) {
  return {
    preset: range.preset, from: range.from, to: range.to, days: range.days,
    timeZone: range.timeZone, start: range.start.toISOString(), end: range.end.toISOString(),
  };
}

function filtersInfo(filters) {
  return { ...filters, tableId: filters.tableId ? String(filters.tableId) : null };
}

const inRange = (range) => ({ $gte: range.start, $lt: range.end });

// Bills created in the period (+ table / game type / status filters)
function billMatch(range, filters) {
  const match = { createdAt: inRange(range) };
  if (filters.tableId) match.table = filters.tableId;
  if (filters.gameMode) match.gameMode = filters.gameMode;
  if (filters.billStatus) match.status = filters.billStatus;
  return match;
}

// =====================================================================
// Small aggregation building blocks
// =====================================================================

const NOT_CANCELLED = { $ne: ["$status", "cancelled"] };
const hasStatus = (status) => ({ $eq: ["$status", status] });
const countIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const sumIf = (condition, field) => ({ $sum: { $cond: [condition, field, 0] } });
// The club-local calendar day of a moment, e.g. "2026-10-05" (MongoDB knows the timezones)
const clubDayOf = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: env.clubTimeZone } });

function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null; // one decimal, null = "can't say"
}

// Bill counts and money. Cancelled bills: counted, never added to money.
const BILL_TOTALS = {
  billCount: countIf(NOT_CANCELLED),
  paidCount: countIf(hasStatus("paid")),
  partiallyPaidCount: countIf(hasStatus("partially_paid")),
  unpaidCount: countIf(hasStatus("unpaid")),
  cancelledCount: countIf(hasStatus("cancelled")),
  totalBilled: sumIf(NOT_CANCELLED, "$total"),
  totalPaid: sumIf(NOT_CANCELLED, "$amountPaid"),
};

function finishBillTotals(raw) {
  const totals = {
    billCount: 0, paidCount: 0, partiallyPaidCount: 0, unpaidCount: 0, cancelledCount: 0, totalBilled: 0, totalPaid: 0,
    ...raw,
  };
  delete totals._id;
  return {
    ...totals,
    openCount: totals.unpaidCount + totals.partiallyPaidCount,
    totalOutstanding: totals.totalBilled - totals.totalPaid,
    collectedPercent: percent(totals.totalPaid, totals.totalBilled),
  };
}

// Shared with the dashboard (one definition of "billed / paid / outstanding")
async function summarizeBills(match) {
  const [raw] = await Bill.aggregate([{ $match: match }, { $group: { _id: null, ...BILL_TOTALS } }]);
  return finishBillTotals(raw);
}

// Shared with the dashboard: money actually received in a window (any bill, any day)
async function summarizePayments(window) {
  const [raw] = await Payment.aggregate([
    { $match: { paidAt: inRange(window) } },
    { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  return { amount: raw ? raw.amount : 0, count: raw ? raw.count : 0 };
}

// Payments received in the period, each joined to its bill (for table / game type filters
// and "was the bill from an earlier day?"). The join uses the bills' _id index: one fast lookup each.
function paymentStages(range, filters, { useMethod = true } = {}) {
  const match = { paidAt: inRange(range) };
  if (useMethod && filters.method) match.method = filters.method;
  const stages = [
    { $match: match },
    {
      $lookup: {
        from: Bill.collection.name,
        localField: "bill",
        foreignField: "_id",
        as: "billDoc",
        pipeline: [{ $project: { billNumber: 1, table: 1, tableNumber: 1, tableName: 1, gameMode: 1, createdAt: 1 } }],
      },
    },
    { $unwind: "$billDoc" },
  ];
  const billFilter = {};
  if (filters.tableId) billFilter["billDoc.table"] = filters.tableId;
  if (filters.gameMode) billFilter["billDoc.gameMode"] = filters.gameMode;
  if (Object.keys(billFilter).length > 0) stages.push({ $match: billFilter });
  return stages;
}

// Every day of the period, in order, with the values found (days without records get zeros -
// those zeros are real: nothing happened that day)
function everyDay(range, rows, empty) {
  const byDay = new Map(rows.map((row) => [row._id, row]));
  const days = [];
  for (let date = range.from; date <= range.to; date = shiftDate(date, 1)) {
    const row = byDay.get(date) || {};
    const day = { date, ...empty };
    for (const key of Object.keys(empty)) if (row[key] !== undefined) day[key] = row[key];
    days.push(day);
  }
  return days;
}

// =====================================================================
// 1. Revenue: summary cards + one row per day
// =====================================================================

async function getRevenueReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);

  // Bills and payments are two independent aggregations, run at the same time.
  // $facet = several results from ONE pass over the matching bills.
  const [[bills], [payments]] = await Promise.all([
    Bill.aggregate([
      { $match: billMatch(range, filters) },
      {
        $facet: {
          totals: [{ $group: { _id: null, ...BILL_TOTALS } }],
          days: [{
            $group: {
              _id: clubDayOf("$createdAt"),
              billCount: countIf(NOT_CANCELLED),
              cancelledCount: countIf(hasStatus("cancelled")),
              billed: sumIf(NOT_CANCELLED, "$total"),
              paid: sumIf(NOT_CANCELLED, "$amountPaid"),
            },
          }],
        },
      },
    ]),
    Payment.aggregate([
      ...paymentStages(range, filters),
      {
        $facet: {
          totals: [{ $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }],
          days: [{ $group: { _id: clubDayOf("$paidAt"), received: { $sum: "$amount" }, paymentCount: { $sum: 1 } } }],
        },
      },
    ]),
  ]);

  const summary = finishBillTotals(bills.totals[0]);
  const paymentTotals = payments.totals[0] || { amount: 0, count: 0 };
  const billDays = everyDay(range, bills.days, { billCount: 0, cancelledCount: 0, billed: 0, paid: 0 });
  const paymentDays = new Map(payments.days.map((row) => [row._id, row]));

  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    summary: { ...summary, paymentsReceived: paymentTotals.amount, paymentCount: paymentTotals.count },
    days: billDays.map((day) => ({
      ...day,
      outstanding: day.billed - day.paid,
      received: paymentDays.get(day.date)?.received || 0,
      paymentCount: paymentDays.get(day.date)?.paymentCount || 0,
    })),
    hasData: summary.billCount + summary.cancelledCount + paymentTotals.count > 0,
  };
}

// =====================================================================
// 2. Payments: per payment method (real Payment records)
// =====================================================================

async function getPaymentsReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);

  const [result] = await Payment.aggregate([
    ...paymentStages(range, filters),
    {
      $facet: {
        byMethod: [{ $group: { _id: "$method", count: { $sum: 1 }, amount: { $sum: "$amount" } } }],
        totals: [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } }],
        // Money received in the period for bills created BEFORE the period (e.g. last week's bill paid today)
        earlierBills: [
          { $match: { "billDoc.createdAt": { $lt: range.start } } },
          { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
        ],
      },
    },
  ]);

  const found = new Map(result.byMethod.map((row) => [row._id, row]));
  // All known methods in a fixed order (a 0 here is a real "nobody paid this way"),
  // plus any other method found in the data
  const methods = [...PAYMENT_METHODS, ...[...found.keys()].filter((m) => !PAYMENT_METHODS.includes(m))];
  const totals = result.totals[0] || { count: 0, amount: 0 };
  const earlier = result.earlierBills[0] || { count: 0, amount: 0 };

  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    methods: methods.map((method) => ({
      method,
      count: found.get(method)?.count || 0,
      amount: found.get(method)?.amount || 0,
      sharePercent: percent(found.get(method)?.amount || 0, totals.amount),
    })),
    totals: { count: totals.count, amount: totals.amount },
    forEarlierBills: { count: earlier.count, amount: earlier.amount },
    hasData: totals.count > 0,
  };
}

async function listPayments(range, filters) {
  return Payment.aggregate([
    ...paymentStages(range, filters),
    { $sort: { paidAt: 1, _id: 1 } },
    { $limit: EXPORT_MAX_ROWS + 1 },
    { $project: { amount: 1, method: 1, payerName: 1, paidAt: 1, "receivedBy.name": 1, billDoc: 1 } },
  ]);
}

// =====================================================================
// 3. Game types: grouped by whatever game types are stored on the bills
// =====================================================================

// Sum of the bill's line items of one kind ("game" or "cafe"), worked out per bill inside MongoDB
const lineItemsTotal = (type) => ({
  $sum: {
    $map: {
      input: { $filter: { input: "$lineItems", as: "item", cond: { $eq: ["$$item.type", type] } } },
      as: "item",
      in: "$$item.amount",
    },
  },
});

async function getGamesReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);

  const rows = await Bill.aggregate([
    { $match: billMatch(range, filters) },
    { $addFields: { gameAmount: lineItemsTotal("game"), cafeAmount: lineItemsTotal("cafe") } },
    {
      $group: {
        _id: "$gameMode",
        billCount: countIf(NOT_CANCELLED),
        cancelledCount: countIf(hasStatus("cancelled")),
        quantity: sumIf(NOT_CANCELLED, "$quantity"), // the mode's counted unit (registry quantityLabel)
        gameRevenue: sumIf(NOT_CANCELLED, "$gameAmount"),
        cafeRevenue: sumIf(NOT_CANCELLED, "$cafeAmount"),
        taxAmount: sumIf(NOT_CANCELLED, "$taxAmount"),
        totalBilled: sumIf(NOT_CANCELLED, "$total"),
        totalPaid: sumIf(NOT_CANCELLED, "$amountPaid"),
      },
    },
    { $sort: { totalBilled: -1, _id: 1 } },
  ]);

  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    // Only game types that really have bills in the period - nothing invented
    games: rows.map(({ _id, ...row }) => ({
      gameMode: _id,
      ...row,
      averageBill: row.billCount > 0 ? Math.round(row.totalBilled / row.billCount) : null,
    })),
    hasData: rows.length > 0,
  };
}

// =====================================================================
// 3b. Matches (Phase 11.7): every match that STARTED in the period
// =====================================================================
// A match belongs to the club day it STARTED (like a session). Its bill - one per completed match,
// Phase 11.5 - is shown with the match whatever day the bill was made, so the money here is
// "the bills of these matches" (Revenue counts bills by the day they were CREATED instead).
// Only real Match records: old / whole-session bills never get a match invented for them.

// Matches that started in the period (+ table / game type). gameMode $in -> uses the {gameMode, startedAt} index.
function matchesInPeriod(range, filters) {
  const match = { gameMode: filters.gameMode || { $in: ALL_GAME_MODE_KEYS }, startedAt: inRange(range) };
  if (filters.tableId) match.table = filters.tableId;
  return match;
}

// Each match with its bill and a few flags. Phase 11.8: the bill is found by its OWN `session` + `match`
// reference (the unique {session, match} index: one fast lookup each) - Match.bill is only a pointer,
// so a match whose pointer was never written still shows its bill.
const MATCH_WITH_BILL = [
  {
    $lookup: {
      from: Bill.collection.name,
      let: { session: "$session", match: "$_id" },
      as: "billDoc",
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ["$session", "$$session"] }, { $eq: ["$match", "$$match"] }] } } },
        { $project: { billNumber: 1, status: 1, total: 1, amountPaid: 1 } },
      ],
    },
  },
  {
    $addFields: {
      billDoc: { $first: "$billDoc" },
      registeredCount: { $size: { $filter: { input: "$players", as: "p", cond: { $ne: [{ $ifNull: ["$$p.player", null] }, null] } } } },
      playerCount: { $size: "$players" },
    },
  },
  {
    $addFields: {
      hasBill: { $ne: [{ $ifNull: ["$billDoc", null] }, null] },
      liveBill: { $and: [{ $ne: [{ $ifNull: ["$billDoc", null] }, null] }, { $ne: ["$billDoc.status", "cancelled"] }] },
    },
  },
];

// Counts and money of a group of matches. A cancelled bill is counted, never money (like every report).
const MATCH_TOTALS = {
  total: { $sum: 1 },
  completed: countIf(hasStatus("completed")),
  inProgress: countIf(hasStatus("in_progress")),
  cancelled: countIf(hasStatus("cancelled")),
  billed: countIf("$liveBill"),
  billCancelled: countIf({ $and: ["$hasBill", { $eq: ["$billDoc.status", "cancelled"] }] }),
  notBilled: countIf({ $and: [{ $eq: ["$status", "completed"] }, { $not: ["$hasBill"] }] }),
  // Player places in matches that weren't cancelled: registered players vs walk-ins
  registeredSlots: sumIf(NOT_CANCELLED, "$registeredCount"),
  walkInSlots: sumIf(NOT_CANCELLED, { $subtract: ["$playerCount", "$registeredCount"] }),
  billTotal: sumIf("$liveBill", "$billDoc.total"),
  billPaid: sumIf("$liveBill", "$billDoc.amountPaid"),
};
const EMPTY_MATCH_TOTALS = {
  total: 0, completed: 0, inProgress: 0, cancelled: 0, billed: 0, billCancelled: 0, notBilled: 0,
  registeredSlots: 0, walkInSlots: 0, billTotal: 0, billPaid: 0,
};

function finishMatchTotals(raw) {
  const totals = { ...EMPTY_MATCH_TOTALS, ...raw };
  delete totals._id;
  return {
    ...totals,
    billOutstanding: totals.billTotal - totals.billPaid,
    averageBill: totals.billed > 0 ? Math.round(totals.billTotal / totals.billed) : null,
    registeredPercent: percent(totals.registeredSlots, totals.registeredSlots + totals.walkInSlots),
  };
}

const MATCH_SORT_STAGES = { newest: { startedAt: -1, _id: -1 }, oldest: { startedAt: 1, _id: 1 } };
const MATCH_FIELDS = {
  number: 1, startedAt: 1, endedAt: 1, tableNumber: 1, tableName: 1, gameMode: 1, status: 1, players: 1, teams: 1,
  winningTeam: 1, cancelReason: 1, billDoc: 1,
};

// "Ali vs Guest" / "Team 1: Ali & Mate vs Team 2: Zed & Umar"
function matchPlayersText(match) {
  if (match.teams && match.teams.length) {
    return match.teams.map((team) => `${team.name}: ${match.players.filter((p) => p.team === team.number).map((p) => p.name).join(" & ")}`).join(" vs ");
  }
  return match.players.map((p) => p.name).join(" vs ");
}

// "Winner: Ali" / "Winning team: Team 1 (Ali & Mate)" / "In progress" / "Cancelled"
function matchResultText(match) {
  if (match.status === "in_progress") return "In progress";
  if (match.status === "cancelled") return "Cancelled";
  if (match.winningTeam) {
    const names = match.players.filter((p) => p.team === match.winningTeam).map((p) => p.name).join(" & ");
    return `Winning team: Team ${match.winningTeam} (${names})`;
  }
  return `Winner: ${match.players.filter((p) => p.result === "winner").map((p) => p.name).join(" & ") || "—"}`;
}

function shapeMatch(match) {
  const bill = match.billDoc;
  return {
    id: String(match._id),
    number: match.number,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    tableNumber: match.tableNumber,
    tableName: match.tableName,
    gameMode: match.gameMode,
    status: match.status,
    players: match.players.map((p) => ({ name: p.name, registered: Boolean(p.player), team: p.team ?? null, result: p.result ?? null })),
    playersText: matchPlayersText(match),
    winningTeam: match.winningTeam ?? null,
    resultText: matchResultText(match),
    cancelReason: match.cancelReason || "",
    bill: bill ? {
      id: String(bill._id), billNumber: bill.billNumber, status: bill.status, total: bill.total, amountPaid: bill.amountPaid,
      balanceDue: bill.status === "cancelled" ? 0 : bill.total - bill.amountPaid,
    } : null,
  };
}

// One row per game type of the registry (all four, or the one filtered) - zeros are real: none were played
function gameModeRows(rows, filters) {
  const byMode = new Map(rows.map((row) => [row._id, row]));
  const modes = filters.gameMode ? [filters.gameMode] : [...ALL_GAME_MODE_KEYS, ...[...byMode.keys()].filter((key) => !ALL_GAME_MODE_KEYS.includes(key))];
  return modes.map((gameMode) => ({ gameMode, ...finishMatchTotals(byMode.get(gameMode)) }));
}

async function getMatchesReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  const sort = MATCH_SORTS.includes(query.sort) ? query.sort : "newest";
  const page = query.page || 1;
  const limit = query.limit || REPORT_PAGE_SIZE;

  const [result] = await Match.aggregate([
    { $match: matchesInPeriod(range, filters) },
    ...MATCH_WITH_BILL,
    {
      $facet: {
        summary: [{ $group: { _id: null, ...MATCH_TOTALS } }],
        games: [{ $group: { _id: "$gameMode", ...MATCH_TOTALS } }],
        rows: [{ $sort: MATCH_SORT_STAGES[sort] }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: MATCH_FIELDS }],
      },
    },
  ]);

  const summary = finishMatchTotals(result.summary[0]);
  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    sort,
    summary,
    games: gameModeRows(result.games, filters),
    matches: result.rows.map(shapeMatch),
    pagination: { page, limit, total: summary.total, pages: Math.max(1, Math.ceil(summary.total / limit)) },
    moneyNote: "Money = the bills of these matches (a match belongs to the day it started). Revenue counts bills by the day they were made.",
    hasData: summary.total > 0,
  };
}

// EVERY matching match (no pages) for the CSV. Reads at most maxRows + 1: enough to know "too many".
async function allMatches(range, filters, query, maxRows) {
  const sort = MATCH_SORTS.includes(query.sort) ? query.sort : "newest";
  const rows = await Match.aggregate([
    { $match: matchesInPeriod(range, filters) },
    { $sort: MATCH_SORT_STAGES[sort] },
    { $limit: maxRows + 1 },
    ...MATCH_WITH_BILL,
    { $project: MATCH_FIELDS },
  ]);
  return rows.map(shapeMatch);
}

// =====================================================================
// 3c. Players (Phase 11.7): registered players' activity in the period
// =====================================================================
// The SAME calculations as the player's own history (Phase 11.6, playerHistory.service):
//  - matches: completed matches that STARTED in the period -> played, wins, losses
//  - money:   match bills CREATED in the period (like Revenue / Outstanding) -> the player's OWN
//             share and payments on each bill; outstanding = share - paid on unpaid / partly paid
//             bills. A team-mate's part is never theirs; cancelled bills owe nothing.
// Only references count (Match.players.player, Bill.players.player). Walk-ins (no reference) are
// one separate line and never become players; old / whole-session bills have names only and are
// not counted per player - names are never matched up.

const PLAYER_SORT_ORDER = {
  matches: (a, b) => b.matches - a.matches || b.wins - a.wins,
  wins: (a, b) => b.wins - a.wins || b.matches - a.matches,
  billed: (a, b) => b.billed - a.billed,
  outstanding: (a, b) => b.outstanding - a.outstanding,
  name: () => 0,
};

async function playerActivity(range, filters, sort) {
  const billFilter = { createdAt: inRange(range), match: { $type: "objectId" } }; // match bills: the only bills with player references
  if (filters.tableId) billFilter.table = filters.tableId;
  if (filters.gameMode) billFilter.gameMode = filters.gameMode;

  const [matchRows, billRows] = await Promise.all([
    // Completed matches only: "played", wins and losses (a cancelled or running match isn't played yet)
    Match.aggregate([{ $match: { ...matchesInPeriod(range, filters), status: "completed" } }, ...matchStatsStages()]),
    Bill.aggregate([{ $match: billFilter }, ...billSummaryStages()]),
  ]);

  const byId = new Map();
  const entry = (id) => {
    const key = id ? String(id) : "walk-in";
    if (!byId.has(key)) byId.set(key, { stats: { ...EMPTY_MATCH_STATS }, money: { ...EMPTY_BILL_SUMMARY } });
    return byId.get(key);
  };
  for (const { _id, ...stats } of matchRows) entry(_id).stats = stats;
  for (const { _id, ...money } of billRows) entry(_id).money = money;

  const ids = [...byId.keys()].filter((key) => key !== "walk-in");
  const people = await Player.find({ _id: { $in: ids } }).select("name isActive").lean(); // current names (one query)
  const personById = new Map(people.map((p) => [String(p._id), p]));
  const shape = ({ stats, money }) => ({
    matches: stats.completed,
    wins: stats.wins,
    losses: stats.losses,
    winPercent: percent(stats.wins, stats.wins + stats.losses),
    bills: money.bills,
    cancelledBills: money.cancelledBills,
    openBills: money.openBills,
    billed: money.totalShare,
    paid: money.totalPaid,
    outstanding: money.outstanding,
  });

  const players = ids.map((id) => {
    const person = personById.get(id);
    return { playerId: id, name: person ? person.name : "(unknown player)", isActive: person ? person.isActive : false, ...shape(byId.get(id)) };
  });
  players.sort((a, b) => PLAYER_SORT_ORDER[sort](a, b) || a.name.localeCompare(b.name));
  const walkIns = shape(byId.get("walk-in") || { stats: { ...EMPTY_MATCH_STATS }, money: { ...EMPTY_BILL_SUMMARY } });
  return { players, walkIns };
}

async function getPlayersReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  const sort = PLAYER_SORTS.includes(query.sort) ? query.sort : "matches";
  const page = query.page || 1;
  const limit = query.limit || REPORT_PAGE_SIZE;
  const { players, walkIns } = await playerActivity(range, filters, sort);
  const sum = (key) => players.reduce((total, p) => total + p[key], 0);

  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    sort,
    // Money adds up across players (each share is one player's own). Match and bill COUNTS don't:
    // two registered players in one match each count it, so no total is given for them.
    totals: { players: players.length, billed: sum("billed"), paid: sum("paid"), outstanding: sum("outstanding") },
    players: players.slice((page - 1) * limit, page * limit),
    walkIns,
    pagination: { page, limit, total: players.length, pages: Math.max(1, Math.ceil(players.length / limit)) },
    limitation: "Only registered players are listed, from their own records. Walk-ins are one line. Bills made in the Create Bill window and bills from before matches existed keep player names only, so they are not counted per player.",
    hasData: players.length > 0 || walkIns.matches > 0 || walkIns.bills > 0 || walkIns.cancelledBills > 0,
  };
}

// =====================================================================
// 4. Tables: performance + utilization
// =====================================================================

// Sessions that STARTED in the period, each with its bills. Revenue = the saved totals of its
// bills that aren't cancelled. The table's hourly rate is NOT used: billing doesn't use it.
// Phase 11.5: a session played as matches has one bill per match, so EVERY bill is counted;
// its billed time is the session's (each bill copies it), so it is counted once per session.
async function tableActivity(range, filters) {
  const match = { status: { $in: SESSION_STATUSES }, startedAt: inRange(range) }; // status $in -> uses the {status, startedAt} index
  if (filters.tableId) match.table = filters.tableId;

  return Session.aggregate([
    { $match: match },
    {
      $lookup: {
        from: Bill.collection.name,
        localField: "_id",
        foreignField: "session", // one bill for the whole session, or one per match (Phase 11.5)
        as: "bills",
        pipeline: [{ $project: { status: 1, total: 1, billedMinutes: 1 } }],
      },
    },
    {
      $addFields: {
        countedBills: { $filter: { input: "$bills", as: "b", cond: { $ne: ["$$b.status", "cancelled"] } } },
        hasBill: { $gt: [{ $size: "$bills" }, 0] },
        isCompleted: hasStatus("completed"),
      },
    },
    {
      $addFields: {
        sessionBillCount: { $size: "$countedBills" },
        sessionRevenue: { $sum: "$countedBills.total" },
        sessionBilledMinutes: { $ifNull: [{ $max: "$countedBills.billedMinutes" }, 0] },
      },
    },
    { $sort: { startedAt: 1 } }, // so $last gives the newest table name / number
    {
      $group: {
        _id: "$table",
        tableNumber: { $last: "$tableNumber" },
        tableName: { $last: "$tableName" },
        sessionCount: { $sum: 1 },
        completedCount: countIf("$isCompleted"),
        activeCount: countIf({ $not: ["$isCompleted"] }),
        playedSeconds: sumIf("$isCompleted", "$durationSeconds"),
        billCount: { $sum: "$sessionBillCount" },
        unbilledCount: countIf({ $and: ["$isCompleted", { $not: ["$hasBill"] }] }),
        billedMinutes: { $sum: "$sessionBilledMinutes" },
        revenue: { $sum: "$sessionRevenue" },
      },
    },
  ]);
}

// Clock time each table was in use DURING the period (sessions cut to the period's edges;
// a running session counts up to now). Uses the {status, endedAt} index.
async function occupiedTime(range, filters, effectiveEnd) {
  const match = {
    startedAt: { $lt: effectiveEnd },
    $or: [{ status: "active" }, { status: "completed", endedAt: { $gt: range.start } }],
  };
  if (filters.tableId) match.table = filters.tableId;

  return Session.aggregate([
    { $match: match },
    {
      $project: {
        table: 1,
        tableNumber: 1,
        tableName: 1,
        startedAt: 1,
        overlapMs: {
          $max: [0, {
            $subtract: [
              { $min: [{ $ifNull: ["$endedAt", effectiveEnd] }, effectiveEnd] },
              { $max: ["$startedAt", range.start] },
            ],
          }],
        },
      },
    },
    { $sort: { startedAt: 1 } }, // so $last gives the newest table number / name (needed for deleted tables)
    { $group: { _id: "$table", occupiedMs: { $sum: "$overlapMs" }, tableNumber: { $last: "$tableNumber" }, tableName: { $last: "$tableName" } } },
  ]);
}

// The one wording for the table utilization figure (API, page help text and docs say the same)
const OBSERVED_UTILIZATION = {
  label: "Observed Utilization",
  description: "Percentage of the selected period represented by recorded table use. This is an estimate because club opening hours and maintenance/closure time are not stored.",
  numerator: "Recorded session time on the table inside the period: each session from its start to its end (a running session up to now), cut off at the period's first and last moment.",
  denominator: "The period's elapsed clock time on that table: from the start of the period (or from when the table was added, if later) to the end of the period (or now, if the period isn't over).",
  definition: "Recorded session time divided by the period's elapsed clock time, counted from when the table was added and up to now. Club opening hours and maintenance/closure time are not stored, so every hour of the period counts as available time: the figure is an estimate and is lower than a utilization based on opening hours would be.",
  dayAllocation: "Recorded table-use time is split across calendar days. A session crossing midnight contributes time to both days.",
};

// How the Sessions column counts (deliberately different from Observed Utilization, see above)
const SESSION_COUNTING = {
  label: "Sessions",
  attributedTo: "startDate",
  description: "Counted on the day the session started.",
  definition: "Each session is counted once, on the club day (Karachi time) it started - even if it ended the next day. A session that started before the period isn't counted, though its time inside the period is part of Observed Utilization.",
};

async function getTablesReport(query, now = new Date()) {
  const range = resolveRange(query, now);
  const filters = readFilters(query);
  const sort = TABLE_SORTS.includes(query.sort) ? query.sort : "revenue";
  // Observed utilization only counts time that has already happened
  const effectiveEnd = new Date(Math.min(range.end.getTime(), now.getTime()));

  const [activity, occupied, tables] = await Promise.all([
    tableActivity(range, filters),
    effectiveEnd > range.start ? occupiedTime(range, filters, effectiveEnd) : [],
    Table.find(filters.tableId ? { _id: filters.tableId } : {}).select("tableNumber name createdAt").lean(),
  ]);

  const activityByTable = new Map(activity.map((row) => [String(row._id), row]));
  const occupiedByTable = new Map(occupied.map((row) => [String(row._id), row.occupiedMs]));
  const empty = { sessionCount: 0, completedCount: 0, activeCount: 0, playedSeconds: 0, billCount: 0, unbilledCount: 0, billedMinutes: 0, revenue: 0 };

  function buildRow(id, base, current) {
    const stats = { ...empty, ...activityByTable.get(id) };
    const occupiedSeconds = Math.floor((occupiedByTable.get(id) || 0) / 1000);
    // OBSERVED UTILIZATION (an estimate) = occupiedSeconds / availableSeconds
    //   occupiedSeconds  = recorded session time inside the period (numerator, see occupiedTime)
    //   availableSeconds = the period's elapsed clock time, from when the table was added, up to now.
    //                      Opening hours aren't stored, so no hours are left out (this is NOT an
    //                      assumption that the club is open all day - it is simply all the clock time).
    // Deleted tables: their add date is gone, so no percentage is given (rather than a wrong one).
    let availableSeconds = null;
    if (current) {
      const from = Math.max(range.start.getTime(), new Date(current.createdAt).getTime());
      availableSeconds = Math.max(0, Math.floor((effectiveEnd.getTime() - from) / 1000));
    }
    return {
      tableId: id,
      tableNumber: current ? current.tableNumber : base.tableNumber,
      tableName: current ? current.name : base.tableName,
      deleted: !current,
      sessionCount: stats.sessionCount,
      completedCount: stats.completedCount,
      activeCount: stats.activeCount,
      unbilledCount: stats.unbilledCount,
      billCount: stats.billCount,
      playedSeconds: stats.playedSeconds,
      averageSessionSeconds: stats.completedCount > 0 ? Math.round(stats.playedSeconds / stats.completedCount) : null,
      billedMinutes: stats.billedMinutes,
      revenue: stats.revenue,
      occupiedSeconds,
      availableSeconds,
      utilizationPercent: availableSeconds ? percent(occupiedSeconds, availableSeconds) : null,
    };
  }

  const rows = tables.map((table) => buildRow(String(table._id), {}, table));
  const shownIds = new Set(rows.map((row) => row.tableId));
  // Tables deleted since, but played on: a row if a session STARTED in the period, or if a session
  // that started earlier was still running in the period (its time must not be lost from the totals)
  for (const row of [...activity, ...occupied]) {
    const id = String(row._id);
    if (!shownIds.has(id)) {
      rows.push(buildRow(id, row, null));
      shownIds.add(id);
    }
  }

  const SORTERS = {
    revenue: (a, b) => b.revenue - a.revenue,
    sessions: (a, b) => b.sessionCount - a.sessionCount,
    billedTime: (a, b) => b.billedMinutes - a.billedMinutes,
    tableNumber: () => 0,
  };
  rows.sort((a, b) => SORTERS[sort](a, b) || a.tableNumber - b.tableNumber);

  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    sort,
    tables: rows,
    totals: {
      sessionCount: sum("sessionCount"), completedCount: sum("completedCount"), playedSeconds: sum("playedSeconds"),
      billedMinutes: sum("billedMinutes"), revenue: sum("revenue"), occupiedSeconds: sum("occupiedSeconds"),
    },
    // What the "sessionCount" column means
    sessionCounting: SESSION_COUNTING,
    // What "utilizationPercent" means (the field name is kept for compatibility; it is shown as "Observed Utilization")
    utilization: {
      label: OBSERVED_UTILIZATION.label,
      isEstimate: true,
      description: OBSERVED_UTILIZATION.description,
      numerator: OBSERVED_UTILIZATION.numerator,
      denominator: OBSERVED_UTILIZATION.denominator,
      definition: OBSERVED_UTILIZATION.definition,
      dayAllocation: OBSERVED_UTILIZATION.dayAllocation,
      attributedTo: "timeWithinEachDay",
      measuredFrom: range.start.toISOString(),
      measuredUntil: effectiveEnd.toISOString(),
    },
    hasData: sum("sessionCount") > 0,
  };
}

// =====================================================================
// 5. Bookings: by status and by day (bookings that START in the period)
// =====================================================================

// The bookings a report looks at: starting in the period, optionally one table and ONE status.
// Used by the summary, the daily rows AND the CSV, so the three always agree.
function bookingMatch(range, filters) {
  const match = { status: filters.bookingStatus || { $in: BOOKING_STATUSES }, startAt: inRange(range) }; // uses the {status, startAt} index
  if (filters.tableId) match.table = filters.tableId;
  return match;
}

// Rates are only meaningful across ALL statuses. With one status selected, "no-shows / no-shows"
// would always be 100%, so the rates are not calculated (null) and ratesAvailable says so.
//   eligible bookings = checked in (completed) + cancelled + no-show  -> bookings whose outcome is known
//   check-in rate     = completed / eligible
//   no-show rate      = no_show   / eligible
//   cancellation rate = cancelled / eligible
// Pending and confirmed bookings are left out: they haven't happened yet (a past one becomes
// a no-show automatically after the grace minutes).
async function getBookingsReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  await bookingsService.markNoShows(); // the same automatic no-show rule as the Bookings page

  const statusCounts = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, countIf(hasStatus(status))]));
  const [result] = await Booking.aggregate([
    { $match: bookingMatch(range, filters) },
    {
      $facet: {
        byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        days: [{ $group: { _id: clubDayOf("$startAt"), total: { $sum: 1 }, ...statusCounts } }],
      },
    },
  ]);

  const counts = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0]));
  for (const row of result.byStatus) counts[row._id] = row.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const eligible = counts.completed + counts.cancelled + counts.no_show;
  const ratesAvailable = !filters.bookingStatus;

  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    statusFilter: filters.bookingStatus, // null = all statuses
    totalBookings: total,
    counts: { total, ...counts, checkedIn: counts.completed, decided: eligible },
    ratesAvailable,
    rates: {
      checkInPercent: ratesAvailable ? percent(counts.completed, eligible) : null,
      noShowPercent: ratesAvailable ? percent(counts.no_show, eligible) : null,
      cancellationPercent: ratesAvailable ? percent(counts.cancelled, eligible) : null,
    },
    ratesNote: ratesAvailable
      ? "Rates = checked in / no-show / cancelled bookings divided by bookings with a known outcome (checked in + cancelled + no-show). Pending and confirmed bookings are not included."
      : "Rates are shown only when All statuses is selected.",
    days: everyDay(range, result.days, { total: 0, ...Object.fromEntries(BOOKING_STATUSES.map((s) => [s, 0])) }),
    hasData: total > 0,
  };
}

async function listBookings(range, filters) {
  const match = bookingMatch(range, filters);
  return Booking.find(match)
    .sort({ startAt: 1, _id: 1 })
    .limit(EXPORT_MAX_ROWS + 1)
    .select("customerName tableNumber tableName startAt endAt status checkedInAt createdBy.name")
    .lean();
}

// =====================================================================
// 6. Customers: only what the booking links really show
// =====================================================================
// Bills keep free-text player names and are NOT linked to customers (Phase 7 decision),
// so there is no customer revenue here. Sessions are linked to a customer only when they
// were started by checking in that customer's booking.

async function getCustomersReport(query) {
  const range = resolveRange(query);
  await bookingsService.markNoShows();

  const [newCustomers, [result]] = await Promise.all([
    Customer.countDocuments({ createdAt: inRange(range) }),
    Booking.aggregate([
      { $match: { status: { $in: BOOKING_STATUSES }, startAt: inRange(range) } },
      {
        $lookup: {
          from: Session.collection.name,
          localField: "session",
          foreignField: "_id",
          as: "sessions",
          pipeline: [{ $project: { durationSeconds: 1 } }],
        },
      },
      {
        $addFields: {
          hasSession: { $gt: [{ $size: "$sessions" }, 0] },
          playedSeconds: { $ifNull: [{ $arrayElemAt: ["$sessions.durationSeconds", 0] }, 0] },
        },
      },
      { $sort: { startAt: 1 } },
      {
        $group: {
          _id: "$customer",
          name: { $last: "$customerName" },
          bookings: { $sum: 1 },
          checkedIn: countIf(hasStatus("completed")),
          noShows: countIf(hasStatus("no_show")),
          cancelled: countIf(hasStatus("cancelled")),
          sessions: countIf("$hasSession"),
          playedSeconds: { $sum: "$playedSeconds" },
          lastVisit: { $max: { $cond: [hasStatus("completed"), "$startAt", null] } },
        },
      },
      {
        $facet: {
          stats: [{
            $group: {
              _id: null,
              customersWithBookings: { $sum: 1 },
              customersCheckedIn: countIf({ $gt: ["$checkedIn", 0] }),
              repeatCustomers: countIf({ $gte: ["$checkedIn", 2] }), // checked in on 2+ bookings in the period
            },
          }],
          topByBookings: [{ $sort: { bookings: -1, checkedIn: -1, name: 1 } }, { $limit: TOP_CUSTOMERS }],
          topBySessions: [{ $match: { sessions: { $gt: 0 } } }, { $sort: { sessions: -1, playedSeconds: -1, name: 1 } }, { $limit: TOP_CUSTOMERS }],
        },
      },
    ]),
  ]);

  // Current names in ONE query (not one query per customer)
  const ids = [...result.topByBookings, ...result.topBySessions].map((row) => row._id);
  const customers = await Customer.find({ _id: { $in: ids } }).select("name isActive").lean();
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  const shape = (row) => {
    const customer = byId.get(String(row._id));
    return {
      customerId: String(row._id),
      name: customer ? customer.name : row.name,
      archived: customer ? !customer.isActive : true,
      bookings: row.bookings, checkedIn: row.checkedIn, noShows: row.noShows, cancelled: row.cancelled,
      sessions: row.sessions, playedSeconds: row.playedSeconds, lastVisit: row.lastVisit,
    };
  };
  const stats = result.stats[0] || { customersWithBookings: 0, customersCheckedIn: 0, repeatCustomers: 0 };
  delete stats._id;

  return {
    range: rangeInfo(range),
    stats: { newCustomers, ...stats },
    topByBookings: result.topByBookings.map(shape),
    topBySessions: result.topBySessions.map(shape),
    limitation: "Bills store free-text player names and are not linked to customers, so customer revenue is not reported. Sessions count only when they were started by checking in the customer's booking.",
    hasData: newCustomers + stats.customersWithBookings > 0,
  };
}

// =====================================================================
// 7. Outstanding bills: unpaid / partly paid, with the bill's own saved numbers
// =====================================================================

const OUTSTANDING_SORT_STAGES = {
  oldest: { createdAt: 1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
  balance: { balanceDue: -1, createdAt: 1, _id: 1 },
};

function outstandingMatch(range, filters, allDates) {
  const statuses = OPEN_STATUSES.filter((status) => !filters.billStatus || status === filters.billStatus);
  const match = { status: { $in: statuses } };
  if (!allDates) match.createdAt = inRange(range);
  if (filters.tableId) match.table = filters.tableId;
  if (filters.gameMode) match.gameMode = filters.gameMode;
  return match;
}

const OUTSTANDING_FIELDS = {
  billNumber: 1, createdAt: 1, tableNumber: 1, tableName: 1, "players.name": 1, total: 1, amountPaid: 1, balanceDue: 1, status: 1, gameMode: 1,
};

async function getOutstandingReport(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  const allDates = query.all === true;
  const sort = OUTSTANDING_SORTS.includes(query.sort) ? query.sort : "oldest";
  const page = query.page || 1;
  const limit = query.limit || 25;

  const [result] = await Bill.aggregate([
    { $match: outstandingMatch(range, filters, allDates) }, // uses the {status, createdAt} index
    { $addFields: { balanceDue: { $subtract: ["$total", "$amountPaid"] } } }, // same rule as the bill's own balanceDue
    {
      $facet: {
        totals: [{
          $group: {
            _id: null, count: { $sum: 1 }, totalBilled: { $sum: "$total" }, totalPaid: { $sum: "$amountPaid" },
            totalOutstanding: { $sum: "$balanceDue" }, unpaidCount: countIf(hasStatus("unpaid")), partiallyPaidCount: countIf(hasStatus("partially_paid")),
          },
        }],
        rows: [{ $sort: OUTSTANDING_SORT_STAGES[sort] }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: OUTSTANDING_FIELDS }],
      },
    },
  ]);

  const totals = result.totals[0] || { count: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0, unpaidCount: 0, partiallyPaidCount: 0 };
  delete totals._id;
  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    allDates,
    sort,
    totals,
    bills: result.rows.map(shapeOutstanding),
    pagination: { page, limit, total: totals.count, pages: Math.max(1, Math.ceil(totals.count / limit)) },
    hasData: totals.count > 0,
  };
}

// EVERY matching outstanding bill (no pages), in the chosen order - one query shared by the
// CSV export and the printed report, so both always contain exactly the same bills.
// Reads at most maxRows + 1 bills: one more than allowed is enough to know "too many".
async function allOutstandingBills(range, filters, query, maxRows) {
  const allDates = query.all === true;
  const sort = OUTSTANDING_SORTS.includes(query.sort) ? query.sort : "oldest";
  const bills = await Bill.aggregate([
    { $match: outstandingMatch(range, filters, allDates) },
    { $addFields: { balanceDue: { $subtract: ["$total", "$amountPaid"] } } },
    { $sort: OUTSTANDING_SORT_STAGES[sort] },
    { $limit: maxRows + 1 },
    { $project: OUTSTANDING_FIELDS },
  ]);
  return { bills, allDates, sort, overLimit: bills.length > maxRows };
}

// The complete Outstanding report for PRINTING: same filters and money as the screen, but every
// matching bill instead of one page. Refused (never cut short) above PRINT_MAX_ROWS.
async function getOutstandingPrint(query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  const { bills, allDates, sort, overLimit } = await allOutstandingBills(range, filters, query, PRINT_MAX_ROWS);
  if (overLimit) {
    throw new AppError(
      `There are too many outstanding bills to print at once (more than ${PRINT_MAX_ROWS.toLocaleString("en-US")}). ` +
      "Narrow the period or the filters, or use CSV export.", 400);
  }
  const rows = bills.map(shapeOutstanding);
  const sum = (key) => rows.reduce((total, bill) => total + bill[key], 0);
  return {
    range: rangeInfo(range),
    filters: filtersInfo(filters),
    allDates,
    sort,
    totals: {
      count: rows.length,
      totalBilled: sum("total"),
      totalPaid: sum("amountPaid"),
      totalOutstanding: sum("balanceDue"),
      unpaidCount: rows.filter((b) => b.status === "unpaid").length,
      partiallyPaidCount: rows.filter((b) => b.status === "partially_paid").length,
    },
    bills: rows,
    maxRows: PRINT_MAX_ROWS,
    hasData: rows.length > 0,
  };
}

function shapeOutstanding(bill) {
  return {
    id: String(bill._id),
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    tableNumber: bill.tableNumber,
    tableName: bill.tableName,
    gameMode: bill.gameMode,
    players: bill.players.map((player) => player.name),
    total: bill.total,
    amountPaid: bill.amountPaid,
    balanceDue: bill.balanceDue,
    status: bill.status,
  };
}

// =====================================================================
// Filter choices for the Reports page
// =====================================================================

async function getReportOptions() {
  const [tables, storedModes] = await Promise.all([
    Table.find().sort({ tableNumber: 1 }).select("tableNumber name").lean(),
    Bill.distinct("gameMode"),
  ]);
  return {
    presets: PRESETS,
    defaultPreset: DEFAULT_PRESET,
    maxRangeDays: MAX_RANGE_DAYS,
    timeZone: env.clubTimeZone,
    today: dateInTimeZone(new Date(), env.clubTimeZone),
    tables: tables.map((t) => ({ id: String(t._id), tableNumber: t.tableNumber, name: t.name })),
    // Phase 11.7: every game type of the registry (all four can be billed from matches) + any other stored on bills
    gameModes: [...new Set([...ALL_GAME_MODE_KEYS, ...storedModes])],
    paymentMethods: PAYMENT_METHODS,
    billStatuses: BILL_STATUSES,
    bookingStatuses: BOOKING_STATUSES,
  };
}

// =====================================================================
// CSV exports: the same filters and period as the screen
// =====================================================================

const clubTime = (date) => (date ? formatInTimeZone(new Date(date), env.clubTimeZone) : "");
const tableText = (number, name) => `${number}${name ? ` - ${name}` : ""}`;
const minutesText = (seconds) => (seconds === null || seconds === undefined ? "" : String(Math.round(seconds / 60)));

function tooMany(rows) {
  if (rows.length > EXPORT_MAX_ROWS) {
    throw new AppError(`This export would have more than ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows. Choose a shorter period.`, 400);
  }
}

async function exportReport(report, query) {
  const range = resolveRange(query);
  const filters = readFilters(query);
  let headers;
  let rows;

  if (report === "revenue") {
    const data = await getRevenueReport(query);
    headers = ["Date", "Bills", "Cancelled bills", "Billed (Rs)", "Paid on these bills (Rs)", "Outstanding (Rs)", "Payments received (Rs)", "Payments"];
    rows = data.days.map((d) => [d.date, d.billCount, d.cancelledCount, paisaToRupees(d.billed), paisaToRupees(d.paid),
      paisaToRupees(d.outstanding), paisaToRupees(d.received), d.paymentCount]);
    const s = data.summary;
    rows.push(["Total", s.billCount, s.cancelledCount, paisaToRupees(s.totalBilled), paisaToRupees(s.totalPaid),
      paisaToRupees(s.totalOutstanding), paisaToRupees(s.paymentsReceived), s.paymentCount]);
  } else if (report === "payments") {
    const payments = await listPayments(range, filters);
    tooMany(payments);
    headers = ["Received at", "Bill", "Bill date", "Table", "Game", "Payer", "Method", "Amount (Rs)", "Received by"];
    rows = payments.map((p) => [clubTime(p.paidAt), p.billDoc.billNumber, clubTime(p.billDoc.createdAt),
      tableText(p.billDoc.tableNumber, p.billDoc.tableName), p.billDoc.gameMode, p.payerName, p.method,
      paisaToRupees(p.amount), p.receivedBy?.name || ""]);
  } else if (report === "games") {
    const data = await getGamesReport(query);
    headers = ["Game type", "Bills", "Cancelled bills", "Games / frames", "Game charges (Rs)", "Cafe (Rs)", "Tax (Rs)", "Total billed (Rs)", "Average bill (Rs)"];
    rows = data.games.map((g) => [g.gameMode, g.billCount, g.cancelledCount, g.quantity, paisaToRupees(g.gameRevenue),
      paisaToRupees(g.cafeRevenue), paisaToRupees(g.taxAmount), paisaToRupees(g.totalBilled), g.averageBill === null ? "" : paisaToRupees(g.averageBill)]);
  } else if (report === "matches") {
    const matches = await allMatches(range, filters, query, EXPORT_MAX_ROWS);
    tooMany(matches);
    headers = ["Started at", "Table", "Match", "Game type", "Status", "Players", "Registered players", "Result",
      "Bill", "Bill status", "Bill total (Rs)", "Paid (Rs)", "Remaining (Rs)"];
    rows = matches.map((m) => [clubTime(m.startedAt), tableText(m.tableNumber, m.tableName), m.number, m.gameMode, m.status,
      m.playersText, m.players.filter((p) => p.registered).length, m.resultText,
      m.bill ? m.bill.billNumber : "", m.bill ? m.bill.status : "",
      m.bill ? paisaToRupees(m.bill.total) : "", m.bill ? paisaToRupees(m.bill.amountPaid) : "", m.bill ? paisaToRupees(m.bill.balanceDue) : ""]);
  } else if (report === "players") {
    const sort = PLAYER_SORTS.includes(query.sort) ? query.sort : "matches";
    const { players, walkIns } = await playerActivity(range, filters, sort);
    tooMany(players);
    headers = ["Player", "Status", "Matches played", "Wins", "Losses", "Win %", "Bills", "Billed (Rs)", "Paid (Rs)", "Outstanding (Rs)"];
    const line = (name, status, p) => [name, status, p.matches, p.wins, p.losses, p.winPercent === null ? "" : p.winPercent, p.bills,
      paisaToRupees(p.billed), paisaToRupees(p.paid), paisaToRupees(p.outstanding)];
    rows = players.map((p) => line(p.name, p.isActive ? "active" : "inactive", p));
    rows.push(line("Walk-in players (not registered)", "", walkIns));
  } else if (report === "tables") {
    const data = await getTablesReport(query);
    headers = ["Table", "Name", "Deleted", "Sessions", "Completed", "Played (min)", "Average session (min)", "Billed time (min)",
      "Bills", "Revenue (Rs)", "In use (min)", "Observed utilization (%, estimate)"];
    rows = data.tables.map((t) => [t.tableNumber, t.tableName, t.deleted ? "yes" : "", t.sessionCount, t.completedCount,
      minutesText(t.playedSeconds), minutesText(t.averageSessionSeconds), t.billedMinutes, t.billCount, paisaToRupees(t.revenue),
      minutesText(t.occupiedSeconds), t.utilizationPercent === null ? "" : t.utilizationPercent]);
  } else if (report === "bookings") {
    const bookings = await listBookings(range, filters);
    tooMany(bookings);
    // Phone numbers and notes are left out on purpose (not needed for a report)
    headers = ["Date", "Start", "End", "Table", "Customer", "Status", "Checked in at", "Booked by"];
    rows = bookings.map((b) => {
      const start = clubTime(b.startAt);
      return [start.slice(0, 10), start.slice(11), clubTime(b.endAt).slice(11), tableText(b.tableNumber, b.tableName),
        b.customerName, b.status, clubTime(b.checkedInAt), b.createdBy?.name || ""];
    });
  } else if (report === "outstanding") {
    const { bills } = await allOutstandingBills(range, filters, query, EXPORT_MAX_ROWS);
    tooMany(bills);
    headers = ["Bill", "Date", "Table", "Players", "Total (Rs)", "Paid (Rs)", "Remaining (Rs)", "Status"];
    rows = bills.map(shapeOutstanding).map((b) => [b.billNumber, clubTime(b.createdAt), tableText(b.tableNumber, b.tableName),
      b.players.join(", "), paisaToRupees(b.total), paisaToRupees(b.amountPaid), paisaToRupees(b.balanceDue), b.status]);
  } else {
    throw new AppError(`Unknown report "${report}"`, 400);
  }

  const period = query.all === true && report === "outstanding" ? "all-dates" : `${range.from}_to_${range.to}`;
  return { filename: `${report}_${period}.csv`, csv: toCsv(headers, rows), rowCount: rows.length };
}

module.exports = {
  PRESETS, MAX_RANGE_DAYS, TABLE_SORTS, OUTSTANDING_SORTS, MATCH_SORTS, PLAYER_SORTS, EXPORTS, EXPORT_MAX_ROWS, PRINT_MAX_ROWS,
  resolveRange,
  summarizeBills,
  summarizePayments,
  getRevenueReport,
  getPaymentsReport,
  getGamesReport,
  getMatchesReport,
  getPlayersReport,
  getTablesReport,
  getBookingsReport,
  getCustomersReport,
  getOutstandingReport,
  getOutstandingPrint,
  getReportOptions,
  exportReport,
};
