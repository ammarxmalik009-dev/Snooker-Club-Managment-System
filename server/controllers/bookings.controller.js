// Thin layer between HTTP and the bookings service.

const { matchedData } = require("express-validator");
const bookingsService = require("../services/bookings.service");
const { sendSuccess } = require("../utils/response");

const bodyData = (req) => matchedData(req, { locations: ["body"] });

async function list(req, res) {
  const result = await bookingsService.listBookings(matchedData(req, { locations: ["query"] }));
  sendSuccess(res, "Bookings fetched successfully", { serverTime: new Date().toISOString(), ...result });
}

async function availability(req, res) {
  const { date } = matchedData(req, { locations: ["query"] });
  sendSuccess(res, "Availability fetched successfully", await bookingsService.getAvailability(date));
}

async function getOne(req, res) {
  sendSuccess(res, "Booking fetched successfully", await bookingsService.getBookingById(req.params.id));
}

async function create(req, res) {
  const booking = await bookingsService.createBooking(bodyData(req), req.user);
  sendSuccess(res, `Table ${booking.tableNumber} booked for ${booking.customerName}`, booking, 201);
}

async function update(req, res) {
  const booking = await bookingsService.updateBooking(req.params.id, bodyData(req));
  sendSuccess(res, "Booking updated", booking);
}

async function confirm(req, res) {
  const booking = await bookingsService.confirmBooking(req.params.id);
  sendSuccess(res, `Booking for ${booking.customerName} confirmed`, booking);
}

async function cancel(req, res) {
  const { reason } = bodyData(req);
  const booking = await bookingsService.cancelBooking(req.params.id, reason || "", req.user);
  sendSuccess(res, `Booking for ${booking.customerName} cancelled`, booking);
}

async function checkIn(req, res) {
  const { booking, session } = await bookingsService.checkInBooking(req.params.id, req.user);
  sendSuccess(res, `${booking.customerName} checked in · session started on Table ${booking.tableNumber}`, { booking, session });
}

module.exports = { list, availability, getOne, create, update, confirm, cancel, checkIn };
