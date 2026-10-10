// /api/categories - café product categories (Phase 10). Everyone can see them; admins manage them.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const rules = require("../validators/cafe.validators");
const controller = require("../controllers/cafe.controller");

const router = express.Router();
const canView = requirePermission("cafe:view");
const canManage = requirePermission("products:manage");

router.get("/", canView, validate(rules.categoryListRules), controller.listCategories);           // ?search
router.get("/:id", canView, validate(rules.idRules), controller.getCategory);
router.post("/", canManage, validate(rules.categoryCreateRules), controller.createCategory);     // { name }
router.patch("/:id", canManage, validate(rules.categoryUpdateRules), controller.updateCategory); // { name }
router.delete("/:id", canManage, validate(rules.idRules), controller.deleteCategory);            // 409 if it has products

module.exports = router;
