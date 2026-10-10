// Business rules for registered players (Phase 11.2).
// Players are separate from Customers and are never created automatically, from any name.

const { Player } = require("../models/Player");
const { nameKeyOf } = require("../models/Category");
const AppError = require("../utils/AppError");
const { actorFrom } = require("../models/schemas/actor");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Search by name (any part, any case) or by phone digits ("0300 12" finds "0300-1234567")
function searchFilter(search) {
  const conditions = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
  const digits = search.replace(/\D/g, "");
  if (digits.length >= 3) conditions.push({ phoneDigits: { $regex: escapeRegex(digits) } });
  return { $or: conditions };
}

async function duplicateError(name, excludeId = null) {
  const filter = { nameKey: nameKeyOf(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await Player.findOne(filter).select("name isActive");
  if (!existing) return null;
  const message = existing.isActive
    ? `A player called "${existing.name}" is already registered`
    : `A player called "${existing.name}" is already registered (inactive - reactivate them instead)`;
  return new AppError(message, 409, [{ field: "name", message }]);
}

// The database's unique index is the final guard (two people registering the same name at once)
async function savePlayer(player) {
  try {
    return await player.save();
  } catch (error) {
    if (error.code === 11000) throw (await duplicateError(player.name, player._id)) || new AppError("A player with this name is already registered", 409);
    throw error;
  }
}

async function listPlayers({ search, status = "active", page = 1, limit = 25 } = {}) {
  const filter = {};
  if (status === "active") filter.isActive = true;
  else if (status === "inactive") filter.isActive = false;
  if (search) Object.assign(filter, searchFilter(search));
  const [players, total] = await Promise.all([
    Player.find(filter).sort({ nameKey: 1 }).skip((page - 1) * limit).limit(limit),
    Player.countDocuments(filter),
  ]);
  return { players, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getPlayerById(id) {
  const player = await Player.findById(id);
  if (!player) throw new AppError("Player not found", 404);
  return player;
}

async function createPlayer({ name, phone = "", notes = "" }, actorUser = null) {
  const duplicate = await duplicateError(name);
  if (duplicate) throw duplicate;
  const actor = actorFrom(actorUser);
  return savePlayer(new Player({ name, phone, notes, createdBy: actor, updatedBy: actor }));
}

// Only the fields that are sent change. Renaming to the same name with other capitals is fine.
async function updatePlayer(id, changes, actorUser = null) {
  const player = await getPlayerById(id);
  if (changes.name !== undefined) {
    const duplicate = await duplicateError(changes.name, player._id);
    if (duplicate) throw duplicate;
  }
  for (const key of ["name", "phone", "notes"]) {
    if (changes[key] !== undefined) player[key] = changes[key];
  }
  player.updatedBy = actorFrom(actorUser);
  return savePlayer(player);
}

// Deactivate / reactivate (instead of deleting: matches and bills can point to a player forever)
async function setActive(id, active, actorUser = null) {
  const player = await getPlayerById(id);
  if (player.isActive === active) {
    throw new AppError(`${player.name} is already ${active ? "active" : "inactive"}`, 409);
  }
  player.isActive = active;
  player.deactivatedAt = active ? null : new Date();
  player.updatedBy = actorFrom(actorUser);
  return savePlayer(player);
}

module.exports = { listPlayers, getPlayerById, createPlayer, updatePlayer, setActive };
