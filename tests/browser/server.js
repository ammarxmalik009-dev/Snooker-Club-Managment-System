// Browser-test server: the REAL app (same createApp as npm run dev) + a throw-away database,
// plus the test pages ("suites") and a few test-only helpers on the same address.
// Started by tests/browser/run.js - never part of the real app.
//
// Environment:
//   BROWSER_TEST_PORT     default 3998
//   BROWSER_TEST_DB_URI   default mongodb://127.0.0.1:27017/snooker_club_pro_uitest  (dropped on start)

// ---- Test clock ----
// A suite can set the server's "now" (GET /_clock/<ISO time>) so time-of-day checks give the same
// result whenever the tests run (e.g. "a booking later today" at 23:30). The clock keeps ticking
// from the chosen moment; /_reset and /_clock/real go back to the real time. TEST SERVER ONLY.
let clockOffsetMs = 0;
const RealDate = Date;
// The subclass must be NAMED "Date": Mongoose recognises date fields (type: Date) by the class name
const TestDate = (() => class Date extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + clockOffsetMs);
    else super(...args);
  }
  static now() {
    return RealDate.now() + clockOffsetMs;
  }
})();
global.Date = TestDate;
// Login lifetime long enough that a clock moved back by up to 12 hours never lets MongoDB's
// TTL clean-up (which uses the REAL time) remove a suite's login while it runs.
process.env.SESSION_TTL_HOURS = process.env.SESSION_TTL_HOURS || "48";
// "Backup Now" in the suites writes to a temporary folder, never the club's real BACKUP_DIR
process.env.BACKUP_DIR = require("node:path").join(require("node:os").tmpdir(), "snooker_club_pro_uitest_backups");
require("node:fs").rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });

const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { createApp } = require("../../server/app");
const apiRoutes = require("../../server/routes");
const { apiNotFound, pageNotFound } = require("../../server/middleware/notFound");
const errorHandler = require("../../server/middleware/errorHandler");
const users = require("../../server/services/users.service");
const loginThrottle = require("../../server/services/loginThrottle");

const PORT = Number(process.env.BROWSER_TEST_PORT || 3998);
// Step 1.5: a second listener that serves client/ as plain static files, like a Vercel deployment -
// no pageGuard runs on an HTML page there. The static-pageguard suite runs against THIS port to
// prove the client-side page-role guard (not the server) is what hides a restricted page's content.
const STATIC_PORT = Number(process.env.BROWSER_TEST_STATIC_PORT || PORT + 1);
const DB_URI = process.env.BROWSER_TEST_DB_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_uitest";
const SUITES_DIR = path.join(__dirname, "suites");
const CLIENT_DIR = path.join(__dirname, "..", "..", "client");
const UI_PASSWORD = "Ui-test-pass-123"; // test accounts only, in the throw-away database

const DATA_COLLECTIONS = ["tables", "sessions", "bills", "payments", "settings", "counters", "customers", "bookings",
  "categories", "products", "stockmovements", "cafeorders", "players", "matches"];

(async () => {
  await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 5000 });
  if (!mongoose.connection.name.includes("test")) throw new Error(`Refusing to use a database without "test" in its name: ${mongoose.connection.name}`);
  await mongoose.connection.dropDatabase();
  await mongoose.connection.syncIndexes();
  const db = mongoose.connection;
  const outer = express();
  // Test-only routes shared by BOTH listeners (normal app + static host): /_harness, /_reset and
  // every "fail on purpose" switch work the same way on either port, against the same database.
  const control = express.Router();

  // One test user per role, created fresh (never logged in). Suites log in through the real /api/auth/login.
  async function seedUsers() {
    const admin = await users.createFirstAdmin({ name: "Ui Admin", username: "ui-admin", password: UI_PASSWORD });
    await users.createUser({ name: "Ui Staff", username: "ui-staff", role: "staff", password: UI_PASSWORD }, admin);
    await users.createUser({ name: "Ui Cashier", username: "ui-cashier", role: "cashier", password: UI_PASSWORD }, admin);
  }
  await seedUsers();

  // Switches that make parts of the API fail on purpose (error-state tests)
  const failingReports = new Set();
  let failDashboard = false;
  let failAccess = false; // Step 1.5: GET /api/auth/page-access

  control.get("/_harness/:name", (req, res) => {
    if (!/^[a-z0-9-]+$/.test(req.params.name)) return res.status(400).send("bad name");
    res.sendFile(path.join(SUITES_DIR, `${req.params.name}.html`));
  });

  // SUITE ISOLATION: every suite calls this first. Afterwards the server is exactly like a fresh start:
  //  - every collection emptied (users, login sessions, settings -> defaults, counters, all data)
  //  - the three role users created again: new ids, never logged in
  //  - every old login cookie is dead (its session is gone), so a previous suite's login can't carry over
  //  - the in-memory login throttle and all "fail on purpose" switches cleared
  control.get("/_reset", async (req, res) => {
    for (const { name } of await db.db.listCollections().toArray()) {
      await db.collection(name).deleteMany({});
    }
    await seedUsers();
    loginThrottle.clearAll();
    failingReports.clear();
    failDashboard = false;
    failAccess = false;
    clockOffsetMs = 0; // real time again
    res.json({ reset: true, users: await db.collection("users").countDocuments() });
  });

  // Set the server's "now": /_clock/2026-10-05T12:00:00%2B05:00 (or /_clock/real)
  control.get("/_clock/:when", (req, res) => {
    if (req.params.when === "real") {
      clockOffsetMs = 0;
    } else {
      const target = RealDate.parse(req.params.when);
      if (Number.isNaN(target)) return res.status(400).send("bad time");
      clockOffsetMs = target - RealDate.now();
    }
    res.json({ now: new Date().toISOString(), offsetMinutes: Math.round(clockOffsetMs / 60000) });
  });

  // Clears club data only, keeping users and logins (for use INSIDE a suite)
  control.get("/_drop", async (req, res) => {
    for (const name of DATA_COLLECTIONS) await db.collection(name).deleteMany({});
    res.send("dropped");
  });
  // Move the running session of a table back in time by N seconds (to test timers without waiting)
  control.get("/_backdate/:tableNumber/:seconds", async (req, res) => {
    const startedAt = new Date(Date.now() - Number(req.params.seconds) * 1000);
    const result = await db.collection("sessions").updateOne(
      { tableNumber: Number(req.params.tableNumber), isOpen: true }, { $set: { startedAt } });
    res.json({ matched: result.matchedCount, startedAt });
  });
  // Add N finished sessions in September (for paging tests)
  control.get("/_seed/:count", async (req, res) => {
    const table = await db.collection("tables").findOne({});
    const docs = Array.from({ length: Number(req.params.count) }, (_, i) => {
      const startedAt = new Date(Date.UTC(2026, 8, 1 + (i % 28), 10, 0, 0));
      return { table: table._id, tableNumber: table.tableNumber, tableName: table.name, hourlyRateAtStart: table.hourlyRate,
               status: "completed", isOpen: false, startedAt, endedAt: new Date(startedAt.getTime() + 3600e3), durationSeconds: 3600,
               createdAt: startedAt, updatedAt: startedAt };
    });
    await db.collection("sessions").insertMany(docs);
    res.send("seeded");
  });
  // Move a booking so it starts N minutes from now (negative = already started)
  control.get("/_bookingstart/:id/:minutes", async (req, res) => {
    const startAt = new Date(Date.now() + Number(req.params.minutes) * 60000);
    const booking = await db.collection("bookings").findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    const length = booking.endAt - booking.startAt;
    await db.collection("bookings").updateOne({ _id: booking._id }, { $set: { startAt, endAt: new Date(startAt.getTime() + length) } });
    res.json({ startAt });
  });
  // Set a date field on one record (to put test data into a past period)
  control.get("/_setdate/:collection/:id/:field/:iso", async (req, res) => {
    const allowed = ["bills", "payments", "sessions", "bookings", "customers", "tables", "matches", "players"]; // matches, players: Phase 11.7
    if (!allowed.includes(req.params.collection)) return res.status(400).send("no");
    const result = await db.collection(req.params.collection).updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) }, { $set: { [req.params.field]: new Date(req.params.iso) } });
    res.json({ matched: result.matchedCount });
  });
  // Make chosen report endpoints fail with 503 (to test error + Retry)
  control.get("/_failreport/:name/:mode", (req, res) => {
    if (req.params.mode === "on") failingReports.add(req.params.name); else failingReports.delete(req.params.name);
    res.send([...failingReports].join(",") || "none");
  });
  control.get("/api/reports/:name", (req, res, next) => {
    if (!failingReports.has(req.params.name)) return next();
    res.status(503).json({ success: false, message: "The database is not available. Please try again shortly." });
  });
  // e.g. /_failreport/outstanding-print/on makes /api/reports/outstanding/print fail
  control.get("/api/reports/:name/:sub", (req, res, next) => {
    if (!failingReports.has(`${req.params.name}-${req.params.sub}`)) return next();
    res.status(503).json({ success: false, message: "The database is not available. Please try again shortly." });
  });
  // Insert N unpaid bills at one moment, straight into the database (for the print safety-limit test)
  control.get("/_bulkbills/:count/:iso", async (req, res) => {
    const table = await db.collection("tables").findOne({});
    const createdAt = new Date(req.params.iso);
    const docs = Array.from({ length: Number(req.params.count) }, (_, n) => ({
      billNumber: `B-BULK-${Date.now()}-${n}`, session: new mongoose.Types.ObjectId(), table: table._id,
      tableNumber: table.tableNumber, tableName: table.name, sessionStartedAt: createdAt, sessionEndedAt: createdAt,
      durationSeconds: 3600, billedMinutes: 60, gameMode: "century", quantity: 1, unitPrice: 30000,
      lineItems: [{ type: "game", description: "Century", quantity: 1, unitPrice: 30000, amount: 30000 }],
      subtotal: 30000, taxEnabled: false, taxRateBasisPoints: 0, taxAmount: 0, total: 30000, payerRule: "split",
      players: [{ name: "A", result: null, shareAmount: 15000, paidAmount: 0 }, { name: "B", result: null, shareAmount: 15000, paidAmount: 0 }],
      amountPaid: 0, status: "unpaid", createdAt, updatedAt: createdAt,
    }));
    await db.collection("bills").insertMany(docs);
    res.json({ inserted: docs.length });
  });
  // Simulate a broken API for the dashboard (to test error states)
  control.get("/_fail/:mode", (req, res) => { failDashboard = req.params.mode === "on"; res.send(`fail ${failDashboard}`); });
  control.get("/api/dashboard/summary", (req, res, next) => {
    if (!failDashboard) return next();
    res.status(503).json({ success: false, message: "The database is not available. Please try again shortly." });
  });
  // Phase 10: read a product's stock straight from the database (to prove what the API did)
  control.get("/_stock/:id", async (req, res) => {
    const product = await db.collection("products").findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    res.json({ stockQuantity: product ? product.stockQuantity : null });
  });
  // Step 1.5: make the page-access check itself fail (to test the client guard's fail-closed state)
  control.get("/_failaccess/:mode", (req, res) => { failAccess = req.params.mode === "on"; res.send(`failaccess ${failAccess}`); });
  control.get("/api/auth/page-access", (req, res, next) => {
    if (!failAccess) return next();
    res.status(503).json({ success: false, message: "The database is not available. Please try again shortly." });
  });

  outer.use(control);
  outer.use(createApp());
  outer.listen(PORT, () => console.log(`BROWSER-TEST-SERVER READY on ${PORT}`));

  // Step 1.5: the "static host" listener - client/ served as plain files (express.static), with NO
  // pageGuard, exactly like Vercel. /api/* keeps the real backend's own checks (requireAuth, roles).
  const staticOuter = express();
  staticOuter.use(control); // same /_harness, /_reset and fail switches, same database
  staticOuter.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  staticOuter.use(express.json({ limit: "100kb" }));
  staticOuter.use(cookieParser());
  staticOuter.use("/api", apiRoutes);
  staticOuter.use("/api", apiNotFound);
  staticOuter.use(express.static(CLIENT_DIR)); // no pageGuard: every page file is public, like Vercel
  staticOuter.use(pageNotFound);
  staticOuter.use(errorHandler);
  staticOuter.listen(STATIC_PORT, () => console.log(`BROWSER-TEST-STATIC-SERVER READY on ${STATIC_PORT}`));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
