// Thin layer between HTTP and the reports service (all figures are calculated there).

const { matchedData } = require("express-validator");
const reportsService = require("../services/reports.service");
const { sendSuccess } = require("../utils/response");

const queryData = (req) => matchedData(req, { locations: ["query"] });

async function options(req, res) {
  sendSuccess(res, "Report options fetched", await reportsService.getReportOptions());
}

async function revenue(req, res) {
  sendSuccess(res, "Revenue report", await reportsService.getRevenueReport(queryData(req)));
}

async function payments(req, res) {
  sendSuccess(res, "Payments report", await reportsService.getPaymentsReport(queryData(req)));
}

async function games(req, res) {
  sendSuccess(res, "Game types report", await reportsService.getGamesReport(queryData(req)));
}

async function matches(req, res) {
  sendSuccess(res, "Matches report", await reportsService.getMatchesReport(queryData(req)));
}

async function players(req, res) {
  sendSuccess(res, "Players report", await reportsService.getPlayersReport(queryData(req)));
}

async function tables(req, res) {
  sendSuccess(res, "Table performance report", await reportsService.getTablesReport(queryData(req)));
}

async function bookings(req, res) {
  sendSuccess(res, "Bookings report", await reportsService.getBookingsReport(queryData(req)));
}

async function customers(req, res) {
  sendSuccess(res, "Customers report", await reportsService.getCustomersReport(queryData(req)));
}

async function outstanding(req, res) {
  sendSuccess(res, "Outstanding bills", await reportsService.getOutstandingReport(queryData(req)));
}

async function outstandingPrint(req, res) {
  sendSuccess(res, "Outstanding bills for printing", await reportsService.getOutstandingPrint(queryData(req)));
}

// A CSV file download (not JSON). The filename only contains the report name and dates.
async function exportCsv(req, res) {
  const { filename, csv } = await reportsService.exportReport(req.params.report, queryData(req));
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.send(csv);
}

module.exports = { options, revenue, payments, games, matches, players, tables, bookings, customers, outstanding, outstandingPrint, exportCsv };
