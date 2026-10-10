// Thin layer between HTTP and the matches service (Phase 11.4).

const { matchedData } = require("express-validator");
const matchesService = require("../services/matches.service");
const { gameModeLabel } = require("../config/gameModes");
const { sendSuccess } = require("../utils/response");

const bodyOf = (req) => matchedData(req, { locations: ["body"] });
const title = (match) => `Match #${match.number} (${gameModeLabel(match.gameMode)})`;

async function listForSession(req, res) {
  sendSuccess(res, "Matches fetched successfully", await matchesService.listMatchesForSession(req.params.sessionId));
}

async function start(req, res) {
  const match = await matchesService.startMatch(req.params.sessionId, bodyOf(req), req.user);
  sendSuccess(res, `${title(match)} started`, match, 201);
}

async function getOne(req, res) {
  sendSuccess(res, "Match fetched successfully", await matchesService.getMatchById(req.params.id));
}

async function update(req, res) {
  const match = await matchesService.updateMatch(req.params.id, bodyOf(req), req.user);
  sendSuccess(res, `${title(match)} saved`, match);
}

async function complete(req, res) {
  const match = await matchesService.completeMatch(req.params.id, bodyOf(req), req.user);
  sendSuccess(res, `${title(match)} completed`, match);
}

async function cancel(req, res) {
  const match = await matchesService.cancelMatch(req.params.id, bodyOf(req), req.user);
  sendSuccess(res, `${title(match)} cancelled`, match);
}

async function changeResult(req, res) {
  const match = await matchesService.changeResult(req.params.id, bodyOf(req), req.user);
  sendSuccess(res, `Result of match #${match.number} changed`, match);
}

module.exports = { listForSession, start, getOne, update, complete, cancel, changeResult };
