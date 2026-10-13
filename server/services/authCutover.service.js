// Login/logout/session resolution - the Group 2 cutover adapter (Phase 3). Mirrors Settings'
// own adapter (settingsCutover.service.js, Group 1) exactly: exactly one backend is called per
// invocation, never both, never a catch-and-retry-on-the-other fallback.
//
// NOT WIRED INTO ANYTHING YET, deliberately - this file exists so the adapter itself can be
// built and tested in isolation, same as every earlier pilot/adapter. server/middleware/auth.js
// still requires server/services/auth.service.js (MongoDB) directly; nothing was changed there.
// "users" was NOT added to server/config/cutover.js's KNOWN_ROUTE_GROUPS by this file either -
// see the usersCutoverEnabled() comment below for exactly what that means for testing this file.
//
// User and session shape normalization (deliberate, not accidental): auth.pg.service.js's own
// resolveSession already aliases `session._id = session.id` for drop-in compatibility with
// req.authSession._id. This adapter additionally aliases the returned `user._id` the same way,
// for the same reason - belt-and-braces alongside Phase 3's own identityOf() fix
// (models/schemas/actor.js / db/rowMappers.js), not a replacement for it: identityOf() already
// handles a user object that has ONLY `.id`, but aliasing `._id` here too means any OTHER,
// not-yet-audited piece of code that happens to read `.{_id}` directly keeps working as well,
// without needing to know which backend answered.
//
// This does NOT claim MongoDB and PostgreSQL sessions are interchangeable - a session created
// by one backend's createSession() only ever exists in that backend's own storage (completely
// separate tables/collections, confirmed by reading both implementations), so a cookie from one
// backend simply resolves to `null` (not found) under the other, the same as any other invalid
// token - never a false positive, never a crash.

const { isPgAuthoritative } = require("../config/cutover");
const mongoAuth = require("./auth.service");
const pgAuth = require("./auth.pg.service");

const ROUTE_GROUP = "users";

// Whether PostgreSQL should answer for Users/Auth right now.
//
// `isPgAuthoritative("users")` is SAFE to call even though "users" isn't in KNOWN_ROUTE_GROUPS:
// reading server/config/cutover.js's own logic directly, it only throws when PG_CUTOVER_ROUTES
// itself CONTAINS an unrecognised name - an empty/unset env var (the real, current, every-day
// case) returns `false` without error. So normal production behaviour (nobody has tried to
// activate this) is unaffected and never throws.
//
// The one real limitation (documented, not hidden, per this step's own instruction): there is
// NO way to make this return `true` through the real selector today, short of setting
// PG_CUTOVER_ROUTES=users - which server/config/cutover.js would refuse outright, by design,
// precisely because activation isn't safe yet. So an isolated test that wants to prove "this
// adapter correctly delegates to PostgreSQL when selected" cannot do so through the real
// mechanism without violating that same safety design. The `forcePg` parameter below is the
// documented way around that: an explicit, opt-in override that ONLY a test passes - no
// production caller (today, or whenever this is eventually wired into middleware/controllers)
// has any reason to pass it, since real callers rely on the real selector.
function usersCutoverEnabled(forcePg) {
  if (forcePg !== undefined) return forcePg;
  return isPgAuthoritative(ROUTE_GROUP);
}

async function login(params, { forcePg } = {}) {
  if (!usersCutoverEnabled(forcePg)) return mongoAuth.login(params);
  const result = await pgAuth.login(params);
  return { ...result, user: { ...result.user, _id: result.user.id } };
}

async function resolveSession(token, { forcePg } = {}) {
  if (!usersCutoverEnabled(forcePg)) return mongoAuth.resolveSession(token);
  const result = await pgAuth.resolveSession(token);
  if (!result) return null;
  return { ...result, user: { ...result.user, _id: result.user.id } };
}

async function logout(token, { forcePg } = {}) {
  if (!usersCutoverEnabled(forcePg)) return mongoAuth.logout(token);
  return pgAuth.logout(token);
}

async function endAllSessionsForUser(userId, options = {}) {
  const { forcePg, ...rest } = options;
  if (!usersCutoverEnabled(forcePg)) return mongoAuth.endAllSessionsForUser(userId, rest);
  return pgAuth.endAllSessionsForUser(userId, rest);
}

// COOKIE_NAME/GENERIC_LOGIN_ERROR/cookieOptions are identical on both backends (confirmed byte-
// for-byte in server/tests/postgresUsersAuth.test.js) - re-exported from the MongoDB path
// unconditionally, not branched, since there is only ever one correct answer regardless of
// which backend is authoritative.
module.exports = {
  COOKIE_NAME: mongoAuth.COOKIE_NAME,
  GENERIC_LOGIN_ERROR: mongoAuth.GENERIC_LOGIN_ERROR,
  cookieOptions: mongoAuth.cookieOptions,
  login, resolveSession, logout, endAllSessionsForUser,
  ROUTE_GROUP, usersCutoverEnabled,
};
