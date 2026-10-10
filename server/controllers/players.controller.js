// Thin layer between HTTP and the players service (Phase 11.2).

const { matchedData } = require("express-validator");
const playersService = require("../services/players.service");
const playerHistoryService = require("../services/playerHistory.service");
const { sendSuccess } = require("../utils/response");

async function list(req, res) {
  sendSuccess(res, "Players fetched successfully", await playersService.listPlayers(matchedData(req, { locations: ["query"] })));
}

async function getOne(req, res) {
  sendSuccess(res, "Player fetched successfully", await playersService.getPlayerById(req.params.id));
}

async function create(req, res) {
  const player = await playersService.createPlayer(matchedData(req, { locations: ["body"] }), req.user);
  sendSuccess(res, `Player "${player.name}" registered`, player, 201);
}

async function update(req, res) {
  const player = await playersService.updatePlayer(req.params.id, matchedData(req, { locations: ["body"] }), req.user);
  sendSuccess(res, `Player "${player.name}" saved`, player);
}

async function deactivate(req, res) {
  const player = await playersService.setActive(req.params.id, false, req.user);
  sendSuccess(res, `${player.name} deactivated`, player);
}

async function reactivate(req, res) {
  const player = await playersService.setActive(req.params.id, true, req.user);
  sendSuccess(res, `${player.name} is active again`, player);
}

// Phase 11.6: history, worked out from matches and bills
async function matches(req, res) {
  sendSuccess(res, "Player matches fetched successfully", await playerHistoryService.getPlayerMatches(req.params.id, matchedData(req, { locations: ["query"] })));
}

async function bills(req, res) {
  sendSuccess(res, "Player bills fetched successfully", await playerHistoryService.getPlayerBills(req.params.id, matchedData(req, { locations: ["query"] })));
}

module.exports = { list, getOne, create, update, deactivate, reactivate, matches, bills };
