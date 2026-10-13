// Login, logout and session resolution - PostgreSQL pilot (Phase 3, Group 2). Standalone: not
// wired into any route, middleware or CLI script. server/services/auth.service.js (MongoDB) is
// completely untouched and remains the only thing the running app's login actually uses.
//
// NOT ACTIVATED YET - deliberately, pending a separately approved cutover decision, not because
// of an identity-format blocker (that part is already fixed, see below).
//
// req.user (whatever resolveSession returns here) flows into actorFrom(req.user) for every other
// write anywhere in the app that is STILL MongoDB-authoritative (bills, payments, sessions,
// matches, café orders, bookings, settings, users itself...). This USED to be a hard blocker:
// models/schemas/actor.js's actorSchema originally required `user` to be a real MongoDB
// ObjectId, cast with `mongoose.Schema.Types.ObjectId` - a PostgreSQL-authoritative user's UUID
// id was rejected outright (CastError). Steps 27-29 fixed this: actorSchema.user is now a plain
// `String` validated by `isValidActorIdentity` (ObjectId format OR UUID format), and
// `identityOf()` picks the right identity off either a Mongoose document or a PostgreSQL-shaped
// plain object. A PostgreSQL-authoritative user's actor now embeds correctly into any other
// still-MongoDB-authoritative document - verified directly, not assumed (server/tests/
// actorIdentity.test.js, server/tests/postgresUsersAuthCutover.test.js's own isolation test).
//
// "users" was still deliberately NOT added to server/config/cutover.js's KNOWN_ROUTE_GROUPS -
// there is no way to accidentally turn this on. See docs/POSTGRES_MIGRATION.md's Phase 3 Group 2
// section, and Steps 33-34's own audit/readiness write-ups, for the current, up-to-date list of
// what is already verified versus what a future activation step still needs (a real HTTP
// end-to-end test now exists - server/tests/postgresUsersAuthHttp.test.js - plus admin recovery
// readiness and an operational re-login runbook).
//
// Reused, unmodified: server/utils/password.js's verifyPassword/fakeVerify (the exact same
// scrypt hashing and constant-time comparison this app already uses - not a new algorithm);
// server/services/loginThrottle.js (pure in-memory rate limiting, already database-independent -
// the SAME throttle state is shared with the MongoDB path, since it's keyed by username/IP, not
// by which database answered).
//
// COOKIE_NAME/GENERIC_LOGIN_ERROR/cookieOptions()/hashToken() are small, local copies of
// auth.service.js's own (not an import of that file, which requires "mongoose" to define
// models/User.js/models/AuthSession.js - the same isolation reason every earlier pilot's
// nameKeyOf/normalizeUsername copies exist for, and the reason this file's own isolation test
// still passes). They must stay byte-for-byte identical to auth.service.js's own - the cookie
// the browser receives has to look the same regardless of which backend issued it.

const crypto = require("node:crypto");
const env = require("../config/env");
const AppError = require("../utils/AppError");
const { verifyPassword, fakeVerify } = require("../utils/password");
const throttle = require("./loginThrottle");
const usersPg = require("./users.pg.service");
const authSessionsPg = require("./authSessions.pg.service");

const COOKIE_NAME = "scp_session";
const GENERIC_LOGIN_ERROR = "Invalid username or password.";
const TOUCH_EVERY_MS = 60 * 1000; // update lastSeenAt at most once a minute - same as auth.service.js

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: env.cookieSecure,
    path: "/",
    maxAge: env.sessionTtlHours * 60 * 60 * 1000,
  };
}

function hashToken(token) {
  return crypto.createHmac("sha256", env.authSecret).update(token).digest("hex");
}

// Same rules as auth.service.js's own login: one password check always runs (fakeVerify for an
// unknown username), so response time never reveals whether the username exists; wrong
// password, unknown username and a deactivated account all get the identical generic error.
async function login({ username, password, ip = "", userAgent = "" }) {
  const name = usersPg.normalizeUsername(username);

  const wait = throttle.secondsLocked(name, ip);
  if (wait > 0) {
    throw new AppError(`Too many login attempts. Please wait ${Math.ceil(wait / 60)} minute(s) and try again.`, 429);
  }

  const userRow = await usersPg.getUserByUsernameForLogin(name);
  const passwordOk = userRow ? await verifyPassword(password, userRow.passwordHash) : await fakeVerify(password);

  if (!userRow || !passwordOk || !userRow.active) {
    throttle.recordFailure(name, ip);
    throw new AppError(GENERIC_LOGIN_ERROR, 401);
  }
  throttle.recordSuccess(name);

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await authSessionsPg.createSession({
    userId: userRow.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + env.sessionTtlHours * 60 * 60 * 1000),
    userAgent: String(userAgent),
    ip: String(ip),
  });
  await usersPg.touchLastLogin(userRow.id, now);

  const { passwordHash, ...publicUser } = userRow;
  void passwordHash; // never returned to the caller - the one rule this function exists to enforce
  return { token, user: { ...publicUser, lastLoginAt: now } };
}

// Cookie token -> { user, session }, or null if not logged in / expired / deactivated - the same
// shape auth.service.js's own resolveSession returns. `session._id` is aliased to `session.id`
// for drop-in compatibility with existing code that reads `req.authSession._id`
// (server/controllers/users.controller.js's own setPassword call).
async function resolveSession(token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;

  const session = await authSessionsPg.getValidSessionByTokenHash(hashToken(token));
  if (!session) return null;

  let user;
  try {
    user = await usersPg.getUserById(session.user);
  } catch {
    user = null;
  }
  if (!user || !user.active) {
    await authSessionsPg.revokeSession(session.id); // a deactivated account loses its logins
    return null;
  }

  if (Date.now() - new Date(session.lastSeenAt).getTime() > TOUCH_EVERY_MS) {
    await authSessionsPg.touchLastSeen(session.id, new Date());
  }
  return { user, session: { ...session, _id: session.id } };
}

async function logout(token) {
  if (token && typeof token === "string") await authSessionsPg.revokeSessionByTokenHash(hashToken(token));
}

async function endAllSessionsForUser(userId, options = {}) {
  await authSessionsPg.endAllSessionsForUser(userId, options);
}

module.exports = { COOKIE_NAME, GENERIC_LOGIN_ERROR, cookieOptions, login, resolveSession, logout, endAllSessionsForUser };
