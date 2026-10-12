// Login / logout / "who am I".

const { matchedData } = require("express-validator");
const authService = require("../services/auth.service");
const { permissionsForRole, roleHasPermission, PAGE_PERMISSIONS } = require("../config/permissions");
const { canonicalPagePath, PAGE_NAME } = require("../middleware/auth");
const AppError = require("../utils/AppError");
const { sendSuccess } = require("../utils/response");

// Safe user info for the browser (never the password hash)
function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active,
    permissions: permissionsForRole(user.role), // used ONLY to hide buttons/menus; the server still checks
  };
}

async function login(req, res) {
  const { username, password } = matchedData(req, { locations: ["body"] });
  const { token, user } = await authService.login({ username, password, ip: req.ip, userAgent: req.get("user-agent") || "" });

  // If this browser was logged in as someone else, end that login first
  await authService.logout(req.cookies ? req.cookies[authService.COOKIE_NAME] : undefined);

  res.cookie(authService.COOKIE_NAME, token, authService.cookieOptions());
  sendSuccess(res, `Welcome, ${user.name}`, publicUser(user));
}

async function logout(req, res) {
  await authService.logout(req.cookies ? req.cookies[authService.COOKIE_NAME] : undefined);
  res.clearCookie(authService.COOKIE_NAME, { path: "/", httpOnly: true, sameSite: "strict", secure: authService.cookieOptions().secure });
  sendSuccess(res, "Logged out", null);
}

// 401 when not logged in (handled by requireAuth before this runs)
async function me(req, res) {
  sendSuccess(res, "Logged in", publicUser(req.user));
}

// Step 1.5: "may this logged-in user's role open this page?" - for the browser's page-role guard
// ONLY (a convenience redirect). This is read-only and changes nothing. It uses the EXACT SAME
// logic as pageGuard (middleware/auth.js), so "allowed" here can never disagree with what the
// server would actually do when the page itself is requested: a page with no entry in
// PAGE_PERMISSIONS (most pages) is allowed for any logged-in user, same as pageGuard.
async function pageAccess(req, res) {
  const { page } = matchedData(req, { locations: ["query"] });
  const canonicalPage = canonicalPagePath(page);
  if (!canonicalPage || !PAGE_NAME.test(canonicalPage.canonical)) {
    throw new AppError("Invalid page address", 400);
  }
  const { canonical } = canonicalPage;
  const needed = PAGE_PERMISSIONS[canonical];
  const allowed = !needed || roleHasPermission(req.user.role, needed);
  sendSuccess(res, "Page access checked", { page: canonical, allowed });
}

module.exports = { login, logout, me, pageAccess, publicUser };
