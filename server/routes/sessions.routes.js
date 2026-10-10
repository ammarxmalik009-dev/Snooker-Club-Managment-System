// /api/sessions endpoints.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/sessions.controller");
const rules = require("../validators/sessions.validators");

const router = express.Router();
const canView = requirePermission("sessions:view");
const canManage = requirePermission("sessions:manage");

router.get("/", canView, validate(rules.listRules), controller.list);           // history (?status&from&to&search&page&limit)
router.get("/active", canView, controller.listActive);                          // running sessions + server time
router.get("/:id", canView, validate(rules.idRules), controller.getOne);        // one session
router.post("/", canManage, validate(rules.startRules), controller.start);      // start  { tableId }
router.post("/:id/end", canManage, validate(rules.idRules), controller.end);    // end

module.exports = router;
