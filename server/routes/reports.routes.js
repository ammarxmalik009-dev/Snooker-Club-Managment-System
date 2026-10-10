// /api/reports endpoints (Phase 9). Admin and staff only (permission "reports:view");
// cashiers get 403, logged-out visitors 401 (routes/index.js).

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const rules = require("../validators/reports.validators");
const controller = require("../controllers/reports.controller");

const router = express.Router();

router.use(requirePermission("reports:view"));
// Business figures: never kept in the browser's or a proxy's cache
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/options", controller.options);                                         // filter choices (tables, game types, ...)
router.get("/revenue", validate(rules.reportRules), controller.revenue);            // summary cards + one row per day
router.get("/payments", validate(rules.reportRules), controller.payments);          // per payment method
router.get("/games", validate(rules.reportRules), controller.games);                // per game type
router.get("/matches", validate(rules.matchesRules), controller.matches);           // Phase 11.7: matches started in the period
router.get("/players", validate(rules.playersRules), controller.players);           // Phase 11.7: registered players' activity
router.get("/tables", validate(rules.tablesRules), controller.tables);              // per table + utilization
router.get("/bookings", validate(rules.reportRules), controller.bookings);          // by status and day
router.get("/customers", validate(rules.reportRules), controller.customers);        // booking-based customer figures
router.get("/outstanding", validate(rules.outstandingRules), controller.outstanding); // unpaid / partly paid bills
router.get("/outstanding/print", validate(rules.outstandingPrintRules), controller.outstandingPrint); // ALL matching bills, for printing
router.get("/export/:report", validate(rules.exportRules), controller.exportCsv);    // CSV download

module.exports = router;
