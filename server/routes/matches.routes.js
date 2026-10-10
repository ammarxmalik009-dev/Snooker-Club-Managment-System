// Match endpoints (Phase 11.4). Two routers, the same way the café tab hangs under a session:
//   /api/sessions/:sessionId/matches   list + start (a match always belongs to a session)
//   /api/matches/:id                   one match: view, edit players, complete, cancel, change result
// There is no DELETE: completed and cancelled matches stay in the history.

const express = require("express");
const validate = require("../middleware/validate");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/matches.controller");
const rules = require("../validators/matches.validators");
const billsController = require("../controllers/bills.controller");
const billRules = require("../validators/bills.validators");

const canView = requirePermission("matches:view");
const canManage = requirePermission("matches:manage");
const canCancel = requirePermission("matches:cancel");

const sessionMatchesRouter = express.Router({ mergeParams: true }); // sees :sessionId from the parent path
sessionMatchesRouter.get("/", canView, validate(rules.sessionRules), controller.listForSession);
sessionMatchesRouter.post("/", canManage, validate(rules.createRules), controller.start);        // { gameMode, players: [...] }

const matchesRouter = express.Router();
matchesRouter.get("/:id", canView, validate(rules.idRules), controller.getOne);
matchesRouter.patch("/:id", canManage, validate(rules.updateRules), controller.update);          // { players, gameMode? } while in progress
matchesRouter.post("/:id/complete", canManage, validate(rules.resultRules), controller.complete); // { winnerSeat } | { winningTeam }
matchesRouter.post("/:id/cancel", canCancel, validate(rules.cancelRules), controller.cancel);    // { reason? }
matchesRouter.post("/:id/result", canManage, validate(rules.resultRules), controller.changeResult); // change a completed match's result

// Phase 11.5: the bill of a completed match (same permissions as every other bill)
matchesRouter.get("/:id/bill", requirePermission("bills:view"), validate(billRules.matchIdRules), billsController.getForMatch);
matchesRouter.post("/:id/bill/preview", requirePermission("bills:create"), validate(billRules.matchBillRules), billsController.previewForMatch); // { payerRule, cafePayerRule?, tabItems?, includeCafeTab? }
matchesRouter.post("/:id/bill", requirePermission("bills:create"), validate(billRules.matchBillRules), billsController.createForMatch);

module.exports = { sessionMatchesRouter, matchesRouter };
