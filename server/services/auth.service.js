// Login, logout and "who is this request from?".
//
// How it works:
//  1. Login checks the password against the scrypt hash.
//  2. On success a random 256-bit token is made. The BROWSER gets the token in an httpOnly
//     cookie (JavaScript can't read it); the DATABASE stores only an HMAC of it (keyed with
//     AUTH_SECRET from .env), so a stolen database copy contains no usable tokens.
//  3. Every request: cookie -> HMAC -> find the session -> load the user -> must still be active.
//     So logout, expiry and deactivation take effect on the very next request.

const crypto = require("node:crypto");
const { User, normalizeUsername } = require("../models/User");
const { AuthSession } = require("../models/AuthSession");
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { verifyPassword, fakeVerify } = require("../utils/password");
const throttle = require("./loginThrottle");

const COOKIE_NAME = "scp_session";
const GENERIC_LOGIN_ERROR = "Invalid username or password.";
const TOUCH_EVERY_MS = 60 * 1000; // update lastSeenAt at most once a minute

function hashToken(token) {
  return crypto.createHmac("sha256", env.authSecret).update(token).digest("hex");
}

function cookieOptions() {
  return {
    httpOnly: true,                 // not readable by JavaScript in the page
    sameSite: "strict",             // not sent with requests coming from other websites
    secure: env.cookieSecure,       // HTTPS only (enable COOKIE_SECURE when serving over HTTPS)
    path: "/",
    maxAge: env.sessionTtlHours * 60 * 60 * 1000,
  };
}

async function login({ username, password, ip = "", userAgent = "" }) {
  const name = normalizeUsername(username);

  const wait = throttle.secondsLocked(name, ip);
  if (wait > 0) {
    throw new AppError(`Too many login attempts. Please wait ${Math.ceil(wait / 60)} minute(s) and try again.`, 429);
  }

  const user = await User.findOne({ username: name }).select("+passwordHash");
  // Always run one password check, so the response time doesn't reveal whether the username exists
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : await fakeVerify(password);

  // Wrong password, unknown username and deactivated account all get the SAME answer
  if (!user || !passwordOk || !user.active) {
    throttle.recordFailure(name, ip);
    throw new AppError(GENERIC_LOGIN_ERROR, 401);
  }
  throttle.recordSuccess(name);

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await AuthSession.create({
    tokenHash: hashToken(token),
    user: user._id,
    expiresAt: new Date(now.getTime() + env.sessionTtlHours * 60 * 60 * 1000),
    lastSeenAt: now,
    ip: String(ip).slice(0, 64),
    userAgent: String(userAgent).slice(0, 300),
  });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
  user.lastLoginAt = now;
  return { token, user };
}

// Cookie token -> { user, session }, or null if not logged in / expired / deactivated
async function resolveSession(token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;

  const session = await AuthSession.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;

  const user = await User.findById(session.user);
  if (!user || !user.active) {
    await session.deleteOne(); // a deactivated account loses its logins
    return null;
  }

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await AuthSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
  }
  return { user, session };
}

async function logout(token) {
  if (token && typeof token === "string") await AuthSession.deleteOne({ tokenHash: hashToken(token) });
}

// Log a user out everywhere (e.g. after deactivation or a password reset)
async function endAllSessionsForUser(userId, { exceptSessionId = null } = {}) {
  const filter = { user: userId };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await AuthSession.deleteMany(filter);
}

module.exports = { COOKIE_NAME, GENERIC_LOGIN_ERROR, cookieOptions, login, resolveSession, logout, endAllSessionsForUser };
