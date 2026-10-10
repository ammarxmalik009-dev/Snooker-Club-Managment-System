// /api/bills endpoints.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/bills.controller");
const rules = require("../validators/bills.validators");

const router = express.Router();

router.post("/preview", requirePermission("bills:create"), validate(rules.billInputRules), controller.preview);      // calculate, don't save
router.get("/", requirePermission("bills:view"), validate(rules.listRules), controller.list);                        // history
router.post("/", requirePermission("bills:create"), validate(rules.billInputRules), controller.create);              // create for a session
router.get("/:id", requirePermission("bills:view"), validate(rules.idRules), controller.getOne);                     // one bill + payments
router.post("/:id/cancel", requirePermission("bills:cancel"), validate(rules.cancelRules), controller.cancel);       // cancel (unpaid only)
router.post("/:id/payments", requirePermission("payments:record"), validate(rules.paymentRules), controller.addPayment); // record a payment

module.exports = router;
