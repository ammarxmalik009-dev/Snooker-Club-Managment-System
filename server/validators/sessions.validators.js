// Input rules for the /api/sessions endpoints.

const { body, param, query } = require("express-validator");
const { SESSION_STATUSES } = require("../models/Session");

// A real calendar date written as YYYY-MM-DD (e.g. 2026-10-02; 2026-02-30 is rejected)
function isCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

const idRules = [param("id").isMongoId().withMessage("Invalid session id")];

const startRules = [
  body("tableId")
    .exists({ values: "falsy" })
    .withMessage("Choose a table to start the session on")
    .bail()
    .isMongoId()
    .withMessage("Invalid table id"),
];

const dateQuery = (name, label) =>
  query(name)
    .optional({ values: "falsy" })
    .custom(isCalendarDate)
    .withMessage(`${label} must be a date like 2026-10-02`);

const listRules = [
  query("status")
    .optional({ values: "falsy" })
    .isIn(SESSION_STATUSES)
    .withMessage("Status filter must be one of: " + SESSION_STATUSES.join(", ")),
  dateQuery("from", "From date"),
  dateQuery("to", "To date").custom((to, { req }) => {
    const from = req.query.from;
    if (from && to && isCalendarDate(from) && to < from) throw new Error("To date cannot be before the From date");
    return true;
  }),
  query("search")
    .optional({ values: "falsy" })
    .isString()
    .bail()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Search text must be at most 50 characters"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

module.exports = { idRules, startRules, listRules };
