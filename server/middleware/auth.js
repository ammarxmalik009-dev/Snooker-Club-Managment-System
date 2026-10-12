// Authentication & authorization middleware - every protected request passes through here.
//
//   loadUser          reads the login cookie and sets req.user (or leaves it empty)
//   requireAuth       401 if nobody is logged in
//   requirePermission 403 if the logged-in user's role lacks the permission (config/permissions.js)
//   pageGuard         the same rules for HTML pages: not logged in -> login page; no permission -> dashboard
//   sameOriginOnly    refuses changes (POST/PATCH/DELETE) sent from another website

const path = require("node:path");
const AppError = require("../utils/AppError");
const { roleHasPermission, PERMISSIONS, PAGE_PERMISSIONS } = require("../config/permissions");
const authService = require("../services/auth.service");
const { pageNotFound } = require("./notFound");

async function loadUser(req, res, next) {
  const token = req.cookies ? req.cookies[authService.COOKIE_NAME] : undefined;
  if (!token) return next();

  const found = await authService.resolveSession(token);
  if (found) {
    req.user = found.user;
    req.authSession = found.session;
  } else {
    res.clearCookie(authService.COOKIE_NAME, { path: "/" }); // expired / invalid -> remove it
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new AppError("Please log in to continue.", 401));
  next();
}

function requirePermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission "${permission}"`); // catches typos at startup
  return function checkPermission(req, res, next) {
    if (!req.user) return next(new AppError("Please log in to continue.", 401));
    if (!roleHasPermission(req.user.role, permission)) {
      return next(new AppError("You don't have permission to do this.", 403));
    }
    next();
  };
}

// The page a request really asks for, as the file server will see it (Phase 11.8): URL-decoded
// ("users%2Ehtml" -> "users.html"), "\" as "/", dot segments and double slashes resolved, lower case
// (Windows file names ignore case). Returns null for an address that can't be decoded.
function canonicalPagePath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return { decoded, canonical: path.posix.normalize(decoded.replace(/\\/g, "/")).toLowerCase() };
}

// Every page is a plain lower-case name: /pages/users.html. Anything else under /pages is refused.
const PAGE_NAME = /^\/pages\/[a-z0-9-]+\.html$/;

// HTML pages (everything under /pages/ except the login page).
// Phase 11.8: the rules are applied to the CANONICAL path, never the raw one - so "/pages/users%2Ehtml",
// "/pages//users.html", "/pages/USERS.html" or "/css/../pages/users.html" can't skip the login or the
// role check. A spelling other than the canonical one is sent to the canonical address (which is then
// checked like any other request); names that aren't plain page names get a 404, never the file.
async function pageGuard(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const page = canonicalPagePath(req.path);
  if (!page) return next(new AppError("Invalid page address", 400));
  const { canonical } = page;
  if (!canonical.startsWith("/pages/") && canonical !== "/pages") return next();
  if (!PAGE_NAME.test(canonical)) return pageNotFound(req, res);
  // req.path is the RAW address ("%2E" not decoded): only the exact canonical spelling goes on
  if (req.path !== canonical) {
    const query = req.originalUrl.indexOf("?");
    return res.redirect(canonical + (query === -1 ? "" : req.originalUrl.slice(query)));
  }
  if (canonical === "/pages/login.html") return next();

  const loginUrl = `/pages/login.html?next=${encodeURIComponent(req.originalUrl)}`;
  if (!req.cookies || !req.cookies[authService.COOKIE_NAME]) return res.redirect(loginUrl);

  await loadUser(req, res, () => {});
  if (!req.user) return res.redirect(loginUrl);

  const needed = PAGE_PERMISSIONS[canonical];
  if (needed && !roleHasPermission(req.user.role, needed)) {
    return res.redirect("/pages/dashboard.html?denied=1");
  }
  next();
}

// Extra protection against cross-site requests: if the browser says the request came from
// another website, refuse to change anything. (The SameSite=Strict cookie already stops most
// of these; this is a second layer.) Rules for POST/PATCH/DELETE (GET/HEAD/OPTIONS change nothing):
//  - Origin present: allowed if its host is this server's Host (the app's own pages), or it is
//    exactly one of ALLOWED_ORIGINS (the pages hosted on Vercel, reaching us through the /api rewrite).
//    Anything else - another site, "null", an unreadable value - is refused.
//  - Origin missing: browsers send Origin with these requests, so this is a script, a test or a
//    very old browser. Refused if the browser's Sec-Fetch-Site says another site sent it;
//    allowed otherwise (such a client has no logged-in user's cookie unless it was given one).
// The allowed list is set on the app by createApp (from ALLOWED_ORIGINS in .env).
function sameOriginOnly(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const refuse = () => next(new AppError("Requests from other websites are not allowed.", 403));

  const origin = req.get("origin");
  if (!origin) {
    const fetchSite = (req.get("sec-fetch-site") || "").toLowerCase();
    return fetchSite === "cross-site" || fetchSite === "same-site" ? refuse() : next();
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return refuse();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse();
  if (url.host === req.get("host")) return next();
  const allowedOrigins = req.app.get("allowed origins") || [];
  if (origin === url.origin && allowedOrigins.includes(origin)) return next(); // exact, as browsers send it
  refuse();
}

module.exports = { loadUser, requireAuth, requirePermission, pageGuard, sameOriginOnly, canonicalPagePath, PAGE_NAME };
