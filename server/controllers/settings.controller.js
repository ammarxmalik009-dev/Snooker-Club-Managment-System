// Thin layer between HTTP and the settings service.
//
// Phase 3, Group 1: this requires the cutover adapter (settingsCutover.service.js), not
// settings.service.js directly - the ONLY change this group made to this file. The adapter
// itself decides MongoDB vs PostgreSQL (see docs/POSTGRES_MIGRATION.md); this controller stays
// unaware of which one actually answered.

const { matchedData } = require("express-validator");
const settingsService = require("../services/settingsCutover.service");
const { sendSuccess } = require("../utils/response");

async function get(req, res) {
  sendSuccess(res, "Settings fetched successfully", settingsService.describeSettings(await settingsService.getSettings()));
}

async function update(req, res) {
  const settings = await settingsService.updateSettings(matchedData(req, { locations: ["body"] }), req.user);
  sendSuccess(res, "Settings saved", settingsService.describeSettings(settings));
}

module.exports = { get, update };
