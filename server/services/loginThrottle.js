// Slows down password guessing.
//  - 5 failed logins for one username within 15 minutes -> that username is locked for 15 minutes
//  - 20 failed logins from one IP address within 15 minutes -> that address is locked for 15 minutes
// Works the same for usernames that don't exist, so it reveals nothing about which accounts exist.
// Kept in memory (resets when the server restarts) - simple and enough for one club server.

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = { username: 5, ip: 20 };

const attempts = new Map(); // key -> { count, firstAt, lockedUntil }

function entry(key, now) {
  let item = attempts.get(key);
  if (!item || (now - item.firstAt > WINDOW_MS && item.lockedUntil <= now)) {
    item = { count: 0, firstAt: now, lockedUntil: 0 };
    attempts.set(key, item);
  }
  return item;
}

function keys(username, ip) {
  return [["username", `u:${username}`], ["ip", `ip:${ip}`]];
}

// Returns the number of seconds to wait, or 0 if a login attempt is allowed now
function secondsLocked(username, ip, now = Date.now()) {
  let wait = 0;
  for (const [, key] of keys(username, ip)) {
    const item = attempts.get(key);
    if (item && item.lockedUntil > now) wait = Math.max(wait, Math.ceil((item.lockedUntil - now) / 1000));
  }
  return wait;
}

function recordFailure(username, ip, now = Date.now()) {
  for (const [type, key] of keys(username, ip)) {
    const item = entry(key, now);
    item.count += 1;
    if (item.count >= LIMITS[type]) item.lockedUntil = now + LOCK_MS;
  }
  if (attempts.size > 10000) cleanUp(now); // keep memory small
}

function recordSuccess(username) {
  attempts.delete(`u:${username}`);
}

function cleanUp(now = Date.now()) {
  for (const [key, item] of attempts) {
    if (item.lockedUntil <= now && now - item.firstAt > WINDOW_MS) attempts.delete(key);
  }
}

// Forget every counter and lock. Same effect as restarting the server; used by test servers
// so one test suite's failed logins can never lock out the next suite.
function clearAll() {
  attempts.clear();
}

module.exports = { secondsLocked, recordFailure, recordSuccess, clearAll, LIMITS };
