// Input rules for the /api/customers endpoints.

const { body, param, query } = require("express-validator");

const PHONE_PATTERN = /^[+]?[\d\s-]{7,20}$/; // e.g. 0300-1234567, +92 300 1234567

const idRules = [param("id").isMongoId().withMessage("Invalid customer id")];

function nameRule(required) {
  const chain = body("name");
  if (required) chain.exists({ values: "falsy" }).withMessage("Customer name is required").bail();
  else chain.optional();
  return chain.isString().withMessage("Name must be text").bail()
    .trim().isLength({ min: 2, max: 60 }).withMessage("Name must be 2 to 60 characters");
}

// Phone is optional; empty text means "no phone"
const phoneRule = () =>
  body("phone").optional({ values: "null" }).isString().withMessage("Phone must be text").bail()
    .trim().custom((phone) => phone === "" || PHONE_PATTERN.test(phone))
    .withMessage("Phone must be 7 to 20 digits (spaces, - and a leading + are allowed)");

const notesRule = () =>
  body("notes").optional({ values: "null" }).isString().bail().trim().isLength({ max: 200 }).withMessage("Notes must be at most 200 characters");

const listRules = [
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("includeArchived").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("includeArchived must be true or false")
    .customSanitizer((value) => value === "true"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

const createRules = [nameRule(true), phoneRule(), notesRule()];

const updateRules = [
  ...idRules,
  body().custom((data) => Boolean(data) && ["name", "phone", "notes"].some((field) => field in data))
    .withMessage("Send at least one field to update: name, phone, notes"),
  nameRule(false),
  phoneRule(),
  notesRule(),
];

module.exports = { idRules, listRules, createRules, updateRules, nameRule, PHONE_PATTERN };
