// All API routes are joined here and mounted under /api in app.js.
//
// Order matters:
//  1. PUBLIC: /health (the status light) and /auth (login, logout, "who am I").
//  2. requireAuth: from here on EVERY request must come from a logged-in, active user -> else 401.
//  3. Each module route also checks a permission (config/permissions.js) -> else 403.
// A new module added below is therefore protected automatically.

const express = require("express");
const healthController = require("../controllers/health.controller");
const { loadUser, requireAuth, sameOriginOnly } = require("../middleware/auth");
const { singleQueryValues } = require("../middleware/validate");

const router = express.Router();

// ---- Public ----
router.get("/health", healthController.getHealth); // works even when the database is down

router.use(sameOriginOnly); // changes must come from this app's own pages
router.use(singleQueryValues); // Phase 11.8: ?x=1&x=2 -> 400 (every query value is a single value)
router.use(loadUser);       // who is logged in? (sets req.user)
router.use("/auth", require("./auth.routes"));

// ---- Everything below requires a login ----
router.use(requireAuth);

router.use("/tables", require("./tables.routes"));
router.use("/sessions/:sessionId/cafe-items", require("./cafeTab.routes")); // Phase 10: café tab
const { sessionMatchesRouter, matchesRouter } = require("./matches.routes");
router.use("/sessions/:sessionId/matches", sessionMatchesRouter);            // Phase 11.4: matches of a session
router.use("/sessions", require("./sessions.routes"));
router.use("/bills", require("./bills.routes"));
router.use("/settings", require("./settings.routes"));
router.use("/backups", require("./backups.routes"));
router.use("/dashboard", require("./dashboard.routes"));
router.use("/customers", require("./customers.routes"));
router.use("/bookings", require("./bookings.routes"));
router.use("/users", require("./users.routes"));
router.use("/reports", require("./reports.routes"));
// Phase 10: café products & inventory
router.use("/categories", require("./categories.routes"));
router.use("/products", require("./products.routes"));
router.use("/stock-movements", require("./stockMovements.routes"));
// Phase 11: players, matches & game modes
router.use("/game-modes", require("./gameModes.routes"));
router.use("/players", require("./players.routes"));
router.use("/matches", matchesRouter);

module.exports = router;
