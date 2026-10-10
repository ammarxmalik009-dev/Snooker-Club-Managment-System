// User management (admin only) and the safety rules that stop the club locking itself out.
//
// Safety rules:
//  - There must ALWAYS be at least one active admin.
//  - An admin can't deactivate themselves or take away their own admin role
//    (ask another admin) - so nobody locks themselves out by accident.
//  - Deactivating an account logs it out everywhere at once.

const { User, ROLES, normalizeUsername } = require("../models/User");
const AppError = require("../utils/AppError");
const { hashPassword, passwordProblem } = require("../utils/password");
const { actorFrom } = require("../models/schemas/actor");
const { endAllSessionsForUser } = require("./auth.service");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkPassword(password, username) {
  const problem = passwordProblem(password, username);
  if (problem) throw new AppError(problem, 400, [{ field: "password", message: problem }]);
}

async function countActiveAdmins() {
  return User.countDocuments({ role: "admin", active: true });
}

async function listUsers({ search, role, active } = {}) {
  const filter = {};
  if (role) filter.role = role;
  if (active !== undefined) filter.active = active;
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ name: pattern }, { username: pattern }];
  }
  return User.find(filter).sort({ active: -1, name: 1 });
}

async function getUserById(id) {
  const user = await User.findById(id);
  if (!user) throw new AppError("User not found", 404);
  return user;
}

async function createUser({ name, username, role, password }, actorUser = null) {
  const normalized = normalizeUsername(username);
  checkPassword(password, normalized);
  if (await User.exists({ username: normalized })) {
    throw new AppError(`The username "${normalized}" is already taken`, 409, [{ field: "username", message: "This username is already taken" }]);
  }

  const actor = actorFrom(actorUser);
  try {
    return await User.create({
      name,
      username: normalized,
      role,
      passwordHash: await hashPassword(password),
      createdBy: actor,
      updatedBy: actor,
    });
  } catch (error) {
    if (error.code === 11000) {
      throw new AppError(`The username "${normalized}" is already taken`, 409, [{ field: "username", message: "This username is already taken" }]);
    }
    throw error;
  }
}

// Change name / role / active. actorUser = the admin doing it.
async function updateUser(id, changes, actorUser) {
  const user = await getUserById(id);
  const isSelf = String(user._id) === String(actorUser._id);

  if (isSelf && changes.active === false) {
    throw new AppError("You can't deactivate your own account. Ask another admin.", 409);
  }
  if (isSelf && user.role === "admin" && changes.role && changes.role !== "admin") {
    throw new AppError("You can't remove your own admin role. Ask another admin.", 409);
  }

  const before = { name: user.name, role: user.role, active: user.active };
  if (changes.name !== undefined) user.name = changes.name;
  if (changes.role !== undefined) user.role = changes.role;
  if (changes.active !== undefined) user.active = changes.active;
  user.updatedBy = actorFrom(actorUser);
  await user.save();

  // Never leave the club without an active admin (checked AFTER saving, so two admins
  // changing each other at the same moment can't both succeed)
  const wasActiveAdmin = before.role === "admin" && before.active;
  const isActiveAdmin = user.role === "admin" && user.active;
  if (wasActiveAdmin && !isActiveAdmin && (await countActiveAdmins()) === 0) {
    Object.assign(user, before);
    await user.save();
    throw new AppError("This is the last active admin. Make another user an admin first.", 409);
  }

  if (before.active && !user.active) {
    await endAllSessionsForUser(user._id); // logged out everywhere, right now
  }
  return user;
}

// Admin sets a new password for a user (the old one is never shown)
async function setPassword(id, password, actorUser, { currentSessionId = null } = {}) {
  const user = await getUserById(id);
  checkPassword(password, user.username);
  user.set("passwordHash", await hashPassword(password));
  user.passwordChangedAt = new Date();
  user.updatedBy = actorFrom(actorUser);
  await user.save();

  // Other logins of that user end (the admin's own current login stays, if they changed their own)
  const isSelf = String(user._id) === String(actorUser._id);
  await endAllSessionsForUser(user._id, { exceptSessionId: isSelf ? currentSessionId : null });
  return user;
}

// Used only by "npm run create-admin": refuses if an active admin already exists
async function createFirstAdmin({ name, username, password }) {
  if ((await countActiveAdmins()) > 0) {
    throw new AppError("An active admin already exists. Log in as that admin and add users on the Users page.", 409);
  }
  return createUser({ name, username, role: "admin", password }, null);
}

// ---------- "npm run reset-admin-password" (Phase 11.8) ----------
// For the club owner who forgot the admin password (no other admin can reset it). Terminal only:
// whoever runs it is at the club PC with the database. It can ONLY give an existing, active ADMIN a
// new password - it never creates a user and never touches staff or cashier accounts. All of that
// admin's logins end, so an old cookie can't be used any more.

async function listActiveAdmins() {
  return User.find({ role: "admin", active: true }).sort({ username: 1 }).select("name username");
}

async function resetAdminPassword(username, password) {
  const normalized = normalizeUsername(username);
  const user = await User.findOne({ username: normalized });
  if (!user || user.role !== "admin") throw new AppError(`There is no admin with the username "${normalized}"`, 404);
  if (!user.active) throw new AppError(`The admin "${normalized}" is deactivated. Reset the password of an active admin instead.`, 409);
  checkPassword(password, user.username); // the same rules as everywhere else
  user.set("passwordHash", await hashPassword(password));
  user.passwordChangedAt = new Date();
  user.updatedBy = null; // changed from the terminal, not by a logged-in user
  await user.save();
  await endAllSessionsForUser(user._id); // every old login of this admin ends now
  return user;
}

module.exports = {
  ROLES, listUsers, getUserById, createUser, updateUser, setPassword, createFirstAdmin, countActiveAdmins,
  listActiveAdmins, resetAdminPassword,
};
