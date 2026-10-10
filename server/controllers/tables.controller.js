// Thin layer between HTTP and the tables service:
// read the (already validated) input -> call the service -> send the JSON response.

const { matchedData } = require("express-validator");
const tablesService = require("../services/tables.service");
const { sendSuccess } = require("../utils/response");

// matchedData() returns ONLY the fields our validator rules checked,
// so unexpected extra fields in a request are ignored.

async function list(req, res) {
  const { status, search } = matchedData(req, { locations: ["query"] });
  const tables = await tablesService.listTables({ status, search });
  sendSuccess(res, "Tables fetched successfully", tables);
}

async function summary(req, res) {
  sendSuccess(res, "Table summary fetched successfully", await tablesService.getTableSummary());
}

async function getOne(req, res) {
  sendSuccess(res, "Table fetched successfully", await tablesService.getTableById(req.params.id));
}

async function create(req, res) {
  const table = await tablesService.createTable(matchedData(req, { locations: ["body"] }));
  sendSuccess(res, `Table ${table.tableNumber} added`, table, 201);
}

async function update(req, res) {
  const changes = matchedData(req, { locations: ["body"] });
  const table = await tablesService.updateTable(req.params.id, changes);
  sendSuccess(res, `Table ${table.tableNumber} updated`, table);
}

async function remove(req, res) {
  const table = await tablesService.deleteTable(req.params.id);
  sendSuccess(res, `Table ${table.tableNumber} deleted`, table);
}

module.exports = { list, summary, getOne, create, update, remove };
