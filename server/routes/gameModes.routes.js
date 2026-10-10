// /api/game-modes (Phase 11.1). Everyone who can see sessions may read the game modes
// (the Create Bill window needs them); changing rates stays an admin Settings task.

const express = require("express");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/gameModes.controller");

const router = express.Router();

router.get("/", requirePermission("sessions:view"), controller.list); // [{ key, label, minPlayers, maxPlayers, pricingType, ..., rate, enabled }]

module.exports = router;
