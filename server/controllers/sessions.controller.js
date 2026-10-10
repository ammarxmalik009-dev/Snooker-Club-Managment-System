// Thin layer between HTTP and the sessions service.

const { matchedData } = require("express-validator");
const sessionsService = require("../services/sessions.service");
const { sendSuccess } = require("../utils/response");

async function start(req, res) {
  const { tableId } = matchedData(req, { locations: ["body"] });
  const session = await sessionsService.startSession(tableId, req.user);
  sendSuccess(res, `Session started on Table ${session.tableNumber}`, session, 201);
}

async function end(req, res) {
  const session = await sessionsService.endSession(req.params.id, req.user);
  sendSuccess(res, `Session on Table ${session.tableNumber} ended`, session);
}

// Includes the server's current time, so the browser can run accurate live timers
// even if the computer's own clock is a little wrong.
async function listActive(req, res) {
  const sessions = await sessionsService.listActiveSessions();
  sendSuccess(res, "Active sessions fetched successfully", { serverTime: new Date().toISOString(), sessions });
}

async function list(req, res) {
  const filters = matchedData(req, { locations: ["query"] });
  const result = await sessionsService.listSessions(filters);
  sendSuccess(res, "Sessions fetched successfully", { serverTime: new Date().toISOString(), ...result });
}

async function getOne(req, res) {
  sendSuccess(res, "Session fetched successfully", await sessionsService.getSessionById(req.params.id));
}

module.exports = { start, end, listActive, list, getOne };
