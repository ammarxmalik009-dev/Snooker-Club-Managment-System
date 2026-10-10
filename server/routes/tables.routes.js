// /api/tables endpoints. Each line: URL + method -> permission -> input checks -> controller.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/tables.controller");
const rules = require("../validators/tables.validators");

const router = express.Router();
const canView = requirePermission("tables:view");
const canManage = requirePermission("tables:manage");

router.get("/", canView, validate(rules.listRules), controller.list);              // list (?status=&search=)
router.get("/summary", canView, controller.summary);                                // counts per status
router.get("/:id", canView, validate(rules.idRules), controller.getOne);            // one table
router.post("/", canManage, validate(rules.createRules), controller.create);        // add
router.patch("/:id", canManage, validate(rules.updateRules), controller.update);    // edit some fields
router.delete("/:id", canManage, validate(rules.idRules), controller.remove);       // delete (with safety checks)

module.exports = router;
