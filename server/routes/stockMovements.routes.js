// /api/stock-movements - the stock history of all products (Phase 10). Admin + staff.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const rules = require("../validators/cafe.validators");
const controller = require("../controllers/cafe.controller");

const router = express.Router();

router.get("/", requirePermission("stock:view"), validate(rules.movementListRules), controller.listMovements); // ?productId&type&from&to&page&limit

module.exports = router;
