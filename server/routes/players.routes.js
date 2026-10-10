// /api/players - registered players (Phase 11.2).
//   view: everyone · register/edit: admin + staff · deactivate/reactivate: admin
//   history (Phase 11.6): players:view + matches:view / bills:view
// There is no DELETE: players are deactivated, so matches and bills can always point to them.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/players.controller");
const rules = require("../validators/players.validators");

const router = express.Router();
const canView = requirePermission("players:view");
const canManage = requirePermission("players:manage");
const canDeactivate = requirePermission("players:deactivate");

router.get("/", canView, validate(rules.listRules), controller.list);                        // ?search&status&page&limit
router.get("/:id", canView, validate(rules.idRules), controller.getOne);
// Phase 11.6: history. No new permissions: seeing a player + seeing matches / bills (every role today)
router.get("/:id/matches", canView, requirePermission("matches:view"), validate(rules.historyPageRules), controller.matches); // ?page&limit
router.get("/:id/bills", canView, requirePermission("bills:view"), validate(rules.billHistoryRules), controller.bills);       // ?status&page&limit
router.post("/", canManage, validate(rules.createRules), controller.create);                 // { name, phone?, notes? }
router.patch("/:id", canManage, validate(rules.updateRules), controller.update);             // { name?, phone?, notes? }
router.post("/:id/deactivate", canDeactivate, validate(rules.idRules), controller.deactivate);
router.post("/:id/reactivate", canDeactivate, validate(rules.idRules), controller.reactivate);

module.exports = router;
