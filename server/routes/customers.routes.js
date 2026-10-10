// /api/customers endpoints.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/customers.controller");
const rules = require("../validators/customers.validators");

const router = express.Router();
const canView = requirePermission("customers:view");
const canManage = requirePermission("customers:manage");

router.get("/", canView, validate(rules.listRules), controller.list);              // list / search
router.get("/:id", canView, validate(rules.idRules), controller.getOne);           // profile + booking history
router.post("/", canManage, validate(rules.createRules), controller.create);       // add
router.patch("/:id", canManage, validate(rules.updateRules), controller.update);   // edit
router.delete("/:id", canManage, validate(rules.idRules), controller.remove);      // delete (or archive if they have bookings)

module.exports = router;
