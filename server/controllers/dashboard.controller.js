// Thin layer between HTTP and the dashboard service.

const { matchedData } = require("express-validator");
const dashboardService = require("../services/dashboard.service");
const { sendSuccess } = require("../utils/response");

async function summary(req, res) {
  const { date } = matchedData(req, { locations: ["query"] });
  sendSuccess(res, "Dashboard summary fetched successfully", await dashboardService.getSummary({ date }));
}

module.exports = { summary };
