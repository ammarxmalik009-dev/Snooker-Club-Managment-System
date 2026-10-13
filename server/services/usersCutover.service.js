// User management - the Group 2 cutover adapter (Phase 3). Mirrors Settings' own adapter
// (settingsCutover.service.js, Group 1) and authCutover.service.js (this same group) exactly:
// exactly one backend is called per invocation, never both, never a catch-and-retry fallback.
//
// NOT WIRED INTO ANYTHING YET, deliberately - server/controllers/users.controller.js still
// requires server/services/users.service.js (MongoDB) directly; nothing was changed there.
// "users" was NOT added to server/config/cutover.js's KNOWN_ROUTE_GROUPS. See
// authCutover.service.js's own usersCutoverEnabled() comment for exactly what that means for
// testing this file in isolation (the same `forcePg` override, reused here for consistency -
// both adapters must agree on when PostgreSQL is "on", so they share the one function rather
// than each deciding it separately).
//
// Password hashes are never part of this adapter's own surface: every PG-side function already
// excludes password_hash from its own SELECT (confirmed in users.pg.service.js's own header
// comment) - this adapter adds no new path that could leak one.

const { usersCutoverEnabled } = require("./authCutover.service");
const mongoUsers = require("./users.service");
const pgUsers = require("./users.pg.service");

const ROUTE_GROUP = "users";

async function listUsers(filters, { forcePg } = {}) {
  return usersCutoverEnabled(forcePg) ? pgUsers.listUsers(filters) : mongoUsers.listUsers(filters);
}

async function getUserById(id, { forcePg } = {}) {
  return usersCutoverEnabled(forcePg) ? pgUsers.getUserById(id) : mongoUsers.getUserById(id);
}

async function createUser(data, actorUser, { forcePg } = {}) {
  return usersCutoverEnabled(forcePg) ? pgUsers.createUser(data, actorUser) : mongoUsers.createUser(data, actorUser);
}

async function updateUser(id, changes, actorUser, { forcePg } = {}) {
  return usersCutoverEnabled(forcePg) ? pgUsers.updateUser(id, changes, actorUser) : mongoUsers.updateUser(id, changes, actorUser);
}

async function setPassword(id, password, actorUser, options = {}) {
  const { forcePg, ...rest } = options;
  return usersCutoverEnabled(forcePg) ? pgUsers.setPassword(id, password, actorUser, rest) : mongoUsers.setPassword(id, password, actorUser, rest);
}

async function countActiveAdmins({ forcePg } = {}) {
  return usersCutoverEnabled(forcePg) ? pgUsers.countActiveAdmins() : mongoUsers.countActiveAdmins();
}

module.exports = { listUsers, getUserById, createUser, updateUser, setPassword, countActiveAdmins, ROUTE_GROUP };
