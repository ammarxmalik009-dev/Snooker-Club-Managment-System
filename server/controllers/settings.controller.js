// Thin layer between HTTP and the settings service.

const { matchedData } = require("express-validator");
const settingsService = require("../services/settings.service");
const { sendSuccess } = require("../utils/response");

async function get(req, res) {
  sendSuccess(res, "Settings fetched successfully", settingsService.describeSettings(await settingsService.getSettings()));
}

async function update(req, res) {
  const settings = await settingsService.updateSettings(matchedData(req, { locations: ["body"] }), req.user);
  sendSuccess(res, "Settings saved", settingsService.describeSettings(settings));
}

module.exports = { get, update };
