// GET /api/game-modes - the game modes from the central registry (config/gameModes.js),
// each with today's rate from Settings, so pages never hard-code the list.

const { describeGameModes } = require("../config/gameModes");
const { getSettings } = require("../services/settings.service");
const { sendSuccess } = require("../utils/response");

async function list(req, res) {
  sendSuccess(res, "Game modes fetched successfully", describeGameModes(await getSettings()));
}

module.exports = { list };
