// Input rules for /api/auth and /api/users.
// Login only checks the SHAPE of the input - never says which part was wrong.

const { body, param, query } = require("express-validator");
const { ROLES } = require("../models/User");

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

const loginRules = [
  body("username").isString().withMessage("Enter your username and password").bail()
    .trim().isLength({ min: 1, max: 60 }).withMessage("Enter your username and password"),
  body("password").isString().withMessage("Enter your username and password").bail()
    .isLength({ min: 1, max: 200 }).withMessage("Enter your username and password"),
];

const idRules = [param("id").isMongoId().withMessage("Invalid user id")];

const nameRule = (required) => {
  const chain = body("name");
  if (required) chain.exists({ values: "falsy" }).withMessage("Name is required").bail();
  else chain.optional();
  return chain.isString().bail().trim().isLength({ min: 2, max: 60 }).withMessage("Name must be 2 to 60 characters");
};

const roleRule = (required) => {
  const chain = body("role");
  if (required) chain.exists({ values: "falsy" }).withMessage("Choose a role").bail();
  else chain.optional();
  return chain.isIn(ROLES).withMessage("Role must be one of: " + ROLES.join(", "));
};

// Strength rules are checked in the service (shared with the create-admin script)
const passwordRule = () =>
  body("password").exists({ values: "falsy" }).withMessage("Enter a password").bail().isString().withMessage("Enter a password");

const createUserRules = [
  nameRule(true),
  body("username").exists({ values: "falsy" }).withMessage("Username is required").bail()
    .isString().bail().trim().toLowerCase()
    .matches(USERNAME_PATTERN).withMessage("Username must be 3-30 letters, numbers, dots, dashes or underscores"),
  roleRule(true),
  passwordRule(),
];

const updateUserRules = [
  ...idRules,
  body().custom((data) => Boolean(data) && ["name", "role", "active"].some((f) => f in data))
    .withMessage("Send at least one field to change: name, role, active"),
  nameRule(false),
  roleRule(false),
  body("active").optional().isBoolean({ strict: true }).withMessage("Active must be true or false").bail().toBoolean(),
];

const passwordRules = [...idRules, passwordRule()];

const listUserRules = [
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("role").optional({ values: "falsy" }).isIn(ROLES).withMessage("Role must be one of: " + ROLES.join(", ")),
  query("active").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("Active must be true or false")
    .customSanitizer((value) => value === "true"),
];

module.exports = { loginRules, idRules, createUserRules, updateUserRules, passwordRules, listUserRules, USERNAME_PATTERN };
