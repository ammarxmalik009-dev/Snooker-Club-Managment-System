// /api/bookings endpoints.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/bookings.controller");
const rules = require("../validators/bookings.validators");

const router = express.Router();
const canView = requirePermission("bookings:view");
const canManage = requirePermission("bookings:manage");

router.get("/", canView, validate(rules.listRules), controller.list);                           // list (?date | from&to, status, …)
router.get("/availability", canView, validate(rules.availabilityRules), controller.availability); // day view: tables + bookings
router.get("/:id", canView, validate(rules.idRules), controller.getOne);
router.post("/", canManage, validate(rules.createRules), controller.create);                     // book a table
router.patch("/:id", canManage, validate(rules.updateRules), controller.update);                 // change time / table / notes
router.post("/:id/confirm", canManage, validate(rules.idRules), controller.confirm);
router.post("/:id/cancel", canManage, validate(rules.cancelRules), controller.cancel);
router.post("/:id/check-in", canManage, validate(rules.idRules), controller.checkIn);            // customer arrived -> start session

module.exports = router;
