// /api/auth - the only endpoints that work without being logged in (plus /api/health).

const express = require("express");
const validate = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth");
const controller = require("../controllers/auth.controller");
const rules = require("../validators/auth.validators");

const router = express.Router();

router.post("/login", validate(rules.loginRules), controller.login);
router.post("/logout", controller.logout);
router.get("/me", requireAuth, controller.me); // 401 when not logged in
// Step 1.5: read-only - "may my role open this page?" (client-side page guard, UX only)
router.get("/page-access", requireAuth, validate(rules.pageAccessRules), controller.pageAccess);

module.exports = router;
