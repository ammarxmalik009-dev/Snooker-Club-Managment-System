// Builds the Express app: security headers, JSON parsing, API routes,
// frontend files and error handling. server.js starts it.

const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const apiRoutes = require("./routes");
const { pageGuard } = require("./middleware/auth");
const { apiNotFound, pageNotFound } = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const CLIENT_DIR = path.join(__dirname, "..", "client");
const CHART_JS_FILE = path.join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.min.js");

// options.trustProxy / options.allowedOrigins: only for tests; the app always uses the
// checked TRUST_PROXY and ALLOWED_ORIGINS from .env
function createApp({ trustProxy = env.trustProxy, allowedOrigins = env.allowedOrigins } = {}) {
  const app = express();

  // Behind a hosting proxy (TRUST_PROXY), req.ip is the visitor's IP from X-Forwarded-For,
  // counting only the trusted proxies. Default false: req.ip is the direct connection (club PC).
  app.set("trust proxy", trustProxy);
  // Websites besides this one whose pages may send changes (sameOriginOnly in middleware/auth.js)
  app.set("allowed origins", allowedOrigins);

  // Security headers. All our scripts, styles and fonts are local files, so the
  // default Content-Security-Policy works. "upgrade-insecure-requests" is switched off,
  // so the app also works over plain http on the club's network (e.g. from a tablet).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    })
  );

  // Read JSON request bodies into req.body (max 100 KB - our requests are small)
  app.use(express.json({ limit: "100kb" }));
  // Read cookies (the login cookie) into req.cookies
  app.use(cookieParser());

  // API: everything under /api (login rules are in routes/index.js)
  app.use("/api", apiRoutes);
  app.use("/api", apiNotFound); // unknown /api/... URL -> JSON 404

  // Home page -> dashboard (the page guard sends visitors who aren't logged in to the login page)
  app.get("/", (req, res) => res.redirect("/pages/dashboard.html"));

  // Chart.js (Phase 9 charts) is served from the installed npm package, so it is a local
  // file (the security policy only allows scripts from this server) and updates with npm
  app.get("/vendor/chart.umd.min.js", (req, res) => res.sendFile(CHART_JS_FILE));

  // Pages need a login (and some need a role) - checked on the server before the page is sent
  app.use(pageGuard);

  // Frontend: serve files from client/ (HTML, CSS, JS)
  app.use(express.static(CLIENT_DIR));
  app.use(pageNotFound); // unknown page -> HTML 404

  // Must be last: turns every error into a JSON response
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
