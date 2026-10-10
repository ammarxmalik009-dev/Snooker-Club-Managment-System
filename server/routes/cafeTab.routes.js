// /api/sessions/:sessionId/cafe-items - the café TAB of a session (Phase 10).
// Everyone can see and sell (add / change / remove items) while the session has no bill.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const rules = require("../validators/cafe.validators");
const controller = require("../controllers/cafe.controller");

const router = express.Router({ mergeParams: true }); // sees :sessionId from the parent path
const canSell = requirePermission("cafe:sell");

router.get("/", requirePermission("cafe:view"), validate(rules.tabListRules), controller.listTab);
router.post("/", canSell, validate(rules.tabAddRules), controller.addToTab);                 // { productId | description+unitPrice, quantity, consumer? }
router.patch("/:itemId", canSell, validate(rules.tabUpdateRules), controller.updateTabItem); // { quantity?, consumer? }
router.delete("/:itemId", canSell, validate(rules.tabRemoveRules), controller.removeTabItem);

module.exports = router;
