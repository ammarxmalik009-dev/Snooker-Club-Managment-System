// /api/users - admin only.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/users.controller");
const rules = require("../validators/auth.validators");

const router = express.Router();
router.use(requirePermission("users:manage")); // every route below: admins only

router.get("/", validate(rules.listUserRules), controller.list);
router.get("/:id", validate(rules.idRules), controller.getOne);
router.post("/", validate(rules.createUserRules), controller.create);
router.patch("/:id", validate(rules.updateUserRules), controller.update);
router.post("/:id/password", validate(rules.passwordRules), controller.setPassword);

module.exports = router;
