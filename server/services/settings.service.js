// Club billing settings (rate list, time rule, tax). There is only one settings document;
// it is created with safe defaults the first time it is needed.

const { Setting } = require("../models/Setting");
const { actorFrom } = require("../models/schemas/actor");
const { resolveGameRates } = require("../config/gameModes");
const AppError = require("../utils/AppError");

async function getSettings() {
  // upsert + $setOnInsert: create the document once, never overwrite existing values
  return Setting.findOneAndUpdate(
    { key: "club" },
    { $setOnInsert: { key: "club" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

// What GET/PATCH /api/settings send back: the stored settings, with gameRates as the rates
// that apply TODAY for every mode (set by an admin, else the old field, else the default).
function describeSettings(settings) {
  return { ...settings.toJSON(), gameRates: resolveGameRates(settings) };
}

async function updateSettings(changes, actorUser = null) {
  const { gameRates = {}, ...fields } = changes;
  // framePrice (the old field) and gameRates.frame are the same rate: they are kept in step.
  if ("framePrice" in fields && "frame" in gameRates && fields.framePrice !== gameRates.frame) {
    throw new AppError("Send the Frame rate once (gameRates.frame, or the older framePrice)", 400,
      [{ field: "gameRates.frame", message: "Two different Frame rates were sent" }]);
  }
  if ("framePrice" in fields) gameRates.frame = fields.framePrice;
  if ("frame" in gameRates) fields.framePrice = gameRates.frame;

  const settings = await getSettings();
  Object.assign(settings, fields);
  for (const [key, amount] of Object.entries(gameRates)) settings.set(`gameRates.${key}`, amount);
  settings.updatedBy = actorFrom(actorUser); // audit: which admin changed the settings
  return settings.save(); // runs the model's validation rules
}

module.exports = { getSettings, describeSettings, updateSettings };
