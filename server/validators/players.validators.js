// Input rules for the /api/players endpoints (Phase 11.2).

const { body, param, query } = require("express-validator");
const { PLAYER_NAME } = require("../models/Player");
const { PHONE_PATTERN } = require("./customers.validators"); // same phone rule as customers

const tidy = (value) => String(value).trim().replace(/\s+/g, " "); // "  Ali   Khan " -> "Ali Khan"

const idRules = [param("id").isMongoId().withMessage("Invalid player id")];

function nameRule(required) {
  const chain = body("name");
  if (required) chain.exists({ values: "falsy" }).withMessage("Player name is required").bail();
  else chain.optional();
  return chain.isString().withMessage("Name must be text").bail()
    .customSanitizer(tidy)
    .isLength({ min: PLAYER_NAME.min, max: PLAYER_NAME.max }).withMessage(`Name must be ${PLAYER_NAME.min} to ${PLAYER_NAME.max} characters`);
}

// Phone is optional; empty text means "no phone"
const phoneRule = () =>
  body("phone").optional({ values: "null" }).isString().withMessage("Phone must be text").bail()
    .trim().custom((phone) => phone === "" || PHONE_PATTERN.test(phone))
    .withMessage("Phone must be 7 to 20 digits (spaces, - and a leading + are allowed)");

const notesRule = () =>
  body("notes").optional({ values: "null" }).isString().withMessage("Notes must be text").bail()
    .trim().isLength({ max: 200 }).withMessage("Notes must be at most 200 characters");

const listRules = [
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("status").optional({ values: "falsy" }).isIn(["active", "inactive", "all"]).withMessage("Status must be active, inactive or all"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

const createRules = [nameRule(true), phoneRule(), notesRule()];

const updateRules = [
  ...idRules,
  // (isActive counts as "sent" here, so the only message is the clear one below)
  body().custom((data) => Boolean(data) && ["name", "phone", "notes", "isActive"].some((field) => field in data))
    .withMessage("Send at least one field to update: name, phone, notes"),
  // Active/inactive has its own endpoints (deactivate / reactivate), so it isn't changed here
  body("isActive").not().exists().withMessage("Use Deactivate or Reactivate to change whether a player is active"),
  nameRule(false),
  phoneRule(),
  notesRule(),
];

// Phase 11.6: a player's match and bill history (one page at a time)
const historyPageRules = [
  ...idRules,
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];
const BILL_HISTORY_STATUSES = ["open", "unpaid", "partially_paid", "paid", "cancelled"];
const billHistoryRules = [
  ...historyPageRules,
  query("status").optional({ values: "falsy" }).isIn(BILL_HISTORY_STATUSES)
    .withMessage(`Status filter must be one of: ${BILL_HISTORY_STATUSES.join(", ")}`),
];

module.exports = { idRules, listRules, createRules, updateRules, historyPageRules, billHistoryRules };
