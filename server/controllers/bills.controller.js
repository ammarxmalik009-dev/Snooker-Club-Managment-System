// Thin layer between HTTP and the bills & payments services.

const { matchedData } = require("express-validator");
const billsService = require("../services/bills.service");
const paymentsService = require("../services/payments.service");
const { sendSuccess } = require("../utils/response");

const bodyData = (req) => matchedData(req, { locations: ["body"] });

async function preview(req, res) {
  sendSuccess(res, "Bill preview calculated", await billsService.previewBill(bodyData(req)));
}

async function create(req, res) {
  const bill = await billsService.createBill(bodyData(req), req.user);
  sendSuccess(res, `Bill ${bill.billNumber} created`, bill, 201);
}

async function list(req, res) {
  sendSuccess(res, "Bills fetched successfully", await billsService.listBills(matchedData(req, { locations: ["query"] })));
}

async function getOne(req, res) {
  sendSuccess(res, "Bill fetched successfully", await billsService.getBillWithPayments(req.params.id));
}

async function cancel(req, res) {
  const { reason } = bodyData(req);
  const bill = await billsService.cancelBill(req.params.id, reason || "", req.user);
  sendSuccess(res, `Bill ${bill.billNumber} cancelled`, bill);
}

async function addPayment(req, res) {
  const { payment, bill } = await paymentsService.recordPayment(req.params.id, bodyData(req), req.user);
  const message = bill.status === "paid" ? `Payment saved. Bill ${bill.billNumber} is fully paid` : "Payment saved";
  sendSuccess(res, message, { payment, bill }, 201);
}

// ---------- Match bills (Phase 11.5) ----------

async function previewForMatch(req, res) {
  sendSuccess(res, "Bill preview calculated", await billsService.previewMatchBill(req.params.id, bodyData(req)));
}

async function createForMatch(req, res) {
  const bill = await billsService.createMatchBill(req.params.id, bodyData(req), req.user);
  sendSuccess(res, `Bill ${bill.billNumber} created for match #${bill.matchNumber}`, bill, 201);
}

async function getForMatch(req, res) {
  sendSuccess(res, "Bill fetched successfully", await billsService.getMatchBill(req.params.id));
}

module.exports = { preview, create, list, getOne, cancel, addPayment, previewForMatch, createForMatch, getForMatch };
