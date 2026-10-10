// Input rules for the /api/tables endpoints (checked BEFORE the controller runs).
// The model checks again when saving - two layers of safety.

const { body, param, query } = require("express-validator");
const { TABLE_STATUSES } = require("../models/Table");

const MAX_HOURLY_RATE = 10_000_000; // paisa = Rs 100,000.00 per hour
const UPDATABLE_FIELDS = ["tableNumber", "name", "hourlyRate", "status"];

// Statuses staff may set by hand. "occupied" is set only by starting a session (Phase 4).
const MANUAL_STATUSES = TABLE_STATUSES.filter((status) => status !== "occupied");

// Starts a body-field rule: "required" for create, "optional" for update.
// bail() = stop checking this field after the first problem (one clear message per field).
function field(name, label, required) {
  const chain = body(name);
  if (required) {
    return chain.exists({ values: "null" }).withMessage(`${label} is required`).bail();
  }
  return chain.optional();
}

function tableNumberRule(required) {
  return field("tableNumber", "Table number", required)
    .isInt({ min: 1, max: 999 })
    .withMessage("Table number must be a whole number from 1 to 999")
    .bail()
    .toInt();
}

function nameRule() {
  return body("name")
    .optional({ values: "null" })
    .isString()
    .withMessage("Name must be text")
    .bail()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Name must be at most 50 characters");
}

// hourlyRate arrives in paisa (whole number). The page converts "600.50" -> 60050.
function hourlyRateRule(required) {
  return field("hourlyRate", "Hourly rate", required)
    .isInt({ min: 0, max: MAX_HOURLY_RATE })
    .withMessage("Hourly rate must be between Rs 0 and Rs 100,000")
    .bail()
    .toInt();
}

function statusRule() {
  return body("status")
    .optional()
    .not()
    .equals("occupied")
    .withMessage("A table becomes occupied automatically when a session starts")
    .bail()
    .isIn(MANUAL_STATUSES)
    .withMessage("Status must be one of: " + MANUAL_STATUSES.join(", "));
}

const idRules = [param("id").isMongoId().withMessage("Invalid table id")];

const listRules = [
  query("status")
    .optional({ values: "falsy" })
    .isIn(TABLE_STATUSES)
    .withMessage("Status filter must be one of: " + TABLE_STATUSES.join(", ")),
  query("search")
    .optional({ values: "falsy" })
    .isString()
    .withMessage("Search must be text")
    .bail()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Search text must be at most 50 characters"),
];

const createRules = [tableNumberRule(true), nameRule(), hourlyRateRule(true), statusRule()];

const updateRules = [
  ...idRules,
  body()
    .custom((data) => Boolean(data) && UPDATABLE_FIELDS.some((name) => name in data))
    .withMessage("Send at least one field to update: " + UPDATABLE_FIELDS.join(", ")),
  tableNumberRule(false),
  nameRule(),
  hourlyRateRule(false),
  statusRule(),
];

module.exports = { idRules, listRules, createRules, updateRules };
