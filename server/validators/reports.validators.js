// Input rules for the /api/reports endpoints (all are GET requests with ?query values).

const { query, param } = require("express-validator");
const { BILL_STATUSES } = require("../models/Bill");
const { ALL_GAME_MODE_KEYS } = require("../config/gameModes");
const { PAYMENT_METHODS } = require("../models/Payment");
const { BOOKING_STATUSES } = require("../models/Booking");
const { daysInRange } = require("../utils/time");
const {
  PRESETS, MAX_RANGE_DAYS, TABLE_SORTS, OUTSTANDING_SORTS, MATCH_SORTS, PLAYER_SORTS, EXPORTS,
} = require("../services/reports.service");

// A real calendar date written as YYYY-MM-DD (2026-02-30 is rejected)
function isCalendarDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

const oneOf = (name, values, label) =>
  query(name).optional({ values: "falsy" }).isIn(values).withMessage(`${label} must be one of: ${values.join(", ")}`);

// The period: a preset ("last7") OR a custom From + To (club dates, both included)
const rangeRules = [
  oneOf("preset", PRESETS, "Period"),
  query("from")
    .optional({ values: "falsy" })
    .custom(isCalendarDate).withMessage("From date must be a date like 2026-10-01").bail()
    .custom((from, { req }) => Boolean(req.query.to)).withMessage("Choose both a From and a To date"),
  query("to")
    .optional({ values: "falsy" })
    .custom(isCalendarDate).withMessage("To date must be a date like 2026-10-05").bail()
    .custom((to, { req }) => Boolean(req.query.from)).withMessage("Choose both a From and a To date").bail()
    .custom((to, { req }) => {
      const from = req.query.from;
      if (!isCalendarDate(from)) return true; // reported on "from"
      if (to < from) throw new Error("To date cannot be before the From date");
      if (daysInRange(from, to) > MAX_RANGE_DAYS) throw new Error(`Choose a period of at most ${MAX_RANGE_DAYS} days`);
      return true;
    }),
];

const filterRules = [
  query("tableId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid table id"),
  // Every game type of the registry: since Phase 11.5 all four can be on bills (match bills), and the
  // Reports page offers them (Phase 11.7 - before, Snooker Point / 4 Players were offered but refused)
  oneOf("gameMode", ALL_GAME_MODE_KEYS, "Game type"),
  oneOf("method", PAYMENT_METHODS, "Payment method"),
  oneOf("billStatus", BILL_STATUSES, "Bill status"),
  oneOf("bookingStatus", BOOKING_STATUSES, "Booking status"),
];

const reportRules = [...rangeRules, ...filterRules];

const tablesRules = [...reportRules, oneOf("sort", TABLE_SORTS, "Sort")];

const outstandingRules = [
  ...reportRules,
  oneOf("sort", OUTSTANDING_SORTS, "Sort"),
  query("all").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("All must be true or false").toBoolean(true),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

// Phase 11.7: Matches and Players - sort + one page of rows
const pageRules = [
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];
const matchesRules = [...reportRules, oneOf("sort", MATCH_SORTS, "Sort"), ...pageRules];
const playersRules = [...reportRules, oneOf("sort", PLAYER_SORTS, "Sort"), ...pageRules];

// Printing the complete Outstanding report: the same period, filters, sort and "all dates", no pages
const outstandingPrintRules = [
  ...reportRules,
  oneOf("sort", OUTSTANDING_SORTS, "Sort"),
  query("all").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("All must be true or false").toBoolean(true),
];

const exportRules = [
  param("report").isIn(EXPORTS).withMessage(`Report must be one of: ${EXPORTS.join(", ")}`),
  ...reportRules,
  oneOf("sort", [...new Set([...TABLE_SORTS, ...OUTSTANDING_SORTS, ...MATCH_SORTS, ...PLAYER_SORTS])], "Sort"),
  query("all").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("All must be true or false").toBoolean(true),
];

module.exports = { reportRules, tablesRules, matchesRules, playersRules, outstandingRules, outstandingPrintRules, exportRules, isCalendarDate };
