// /api/products - café products and their stock (Phase 10).
//   view: everyone · add/edit/delete/prices: admin · restock: admin + staff · adjust/waste: admin

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const rules = require("../validators/cafe.validators");
const controller = require("../controllers/cafe.controller");

const router = express.Router();

router.get("/", requirePermission("cafe:view"), validate(rules.productListRules), controller.listProducts); // ?search&categoryId&status&lowStock&trackStock
router.get("/:id", requirePermission("cafe:view"), validate(rules.idRules), controller.getProduct);
router.post("/", requirePermission("products:manage"), validate(rules.productCreateRules), controller.createProduct);
router.patch("/:id", requirePermission("products:manage"), validate(rules.productUpdateRules), controller.updateProduct);
router.delete("/:id", requirePermission("products:manage"), validate(rules.idRules), controller.deleteProduct); // 409 if it has history

router.post("/:id/restock", requirePermission("stock:restock"), validate(rules.restockRules), controller.restock); // { quantity, reason? }
router.post("/:id/adjust", requirePermission("stock:adjust"), validate(rules.adjustRules), controller.adjust);     // { type, quantity, reason }
router.get("/:id/movements", requirePermission("stock:view"), validate([...rules.idRules, ...rules.movementListRules]), controller.productMovements);

module.exports = router;
