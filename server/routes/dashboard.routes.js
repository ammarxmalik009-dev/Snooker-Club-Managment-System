// /api/dashboard endpoints.

const express = require("express");
const { query } = require("express-validator");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/dashboard.controller");

const router = express.Router();

// Optional ?date=YYYY-MM-DD to look at another business day (default: today in the club's timezone)
const summaryRules = [
  query("date")
    .optional({ values: "falsy" })
    .custom((text) => /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text))
    .withMessage("Date must be a date like 2026-10-05"),
];

router.get("/summary", requirePermission("dashboard:view"), validate(summaryRules), controller.summary);

module.exports = router;
