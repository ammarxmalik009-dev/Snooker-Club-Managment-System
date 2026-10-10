// /api/settings endpoints (club rate list, time rule, tax, no-show minutes).
// Everyone may READ them (the bill window shows the prices); only admins may CHANGE them.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/settings.controller");
const rules = require("../validators/settings.validators");

const router = express.Router();

router.get("/", requirePermission("settings:view"), controller.get);
router.patch("/", requirePermission("settings:manage"), validate(rules.updateRules), controller.update);

module.exports = router;
