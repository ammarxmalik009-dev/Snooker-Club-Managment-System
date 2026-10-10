// Thin layer between HTTP and the customers service.

const { matchedData } = require("express-validator");
const customersService = require("../services/customers.service");
const { sendSuccess } = require("../utils/response");

async function list(req, res) {
  sendSuccess(res, "Customers fetched successfully", await customersService.listCustomers(matchedData(req, { locations: ["query"] })));
}

async function getOne(req, res) {
  sendSuccess(res, "Customer fetched successfully", await customersService.getCustomerWithHistory(req.params.id));
}

async function create(req, res) {
  const customer = await customersService.createCustomer(matchedData(req, { locations: ["body"] }));
  sendSuccess(res, `Customer ${customer.name} added`, customer, 201);
}

async function update(req, res) {
  const customer = await customersService.updateCustomer(req.params.id, matchedData(req, { locations: ["body"] }));
  sendSuccess(res, `Customer ${customer.name} updated`, customer);
}

async function remove(req, res) {
  const { result, customer } = await customersService.deleteCustomer(req.params.id);
  const message = result === "deleted"
    ? `Customer ${customer.name} deleted`
    : `Customer ${customer.name} archived (kept because they have bookings)`;
  sendSuccess(res, message, { result, customer });
}

module.exports = { list, getOne, create, update, remove };
