// Business rules for customers (used for bookings).

const { Customer } = require("../models/Customer");
const { Booking } = require("../models/Booking");
const { Session } = require("../models/Session");
const AppError = require("../utils/AppError");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Search by name (any part, any case) or by phone digits ("0300 123" finds "0300-1234567")
function searchFilter(search) {
  const conditions = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
  const digits = search.replace(/\D/g, "");
  if (digits.length >= 3) conditions.push({ phoneDigits: { $regex: escapeRegex(digits) } });
  return { $or: conditions };
}

async function listCustomers({ search, includeArchived = false, page = 1, limit = 25 } = {}) {
  const filter = includeArchived ? {} : { isActive: true };
  if (search) Object.assign(filter, searchFilter(search));

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit),
    Customer.countDocuments(filter),
  ]);

  // Number of bookings and the last booking date for each customer on this page (one query)
  const stats = await Booking.aggregate([
    { $match: { customer: { $in: customers.map((c) => c._id) } } },
    { $group: { _id: "$customer", bookingCount: { $sum: 1 }, lastBookingAt: { $max: "$startAt" } } },
  ]);
  const statsById = new Map(stats.map((s) => [String(s._id), s]));

  return {
    customers: customers.map((customer) => {
      const s = statsById.get(String(customer._id));
      return { ...customer.toJSON(), bookingCount: s ? s.bookingCount : 0, lastBookingAt: s ? s.lastBookingAt : null };
    }),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getCustomerById(id) {
  const customer = await Customer.findById(id);
  if (!customer) throw new AppError("Customer not found", 404);
  return customer;
}

// Profile: the customer, counts, and booking history with the sessions started from them
async function getCustomerWithHistory(id) {
  const customer = await getCustomerById(id);
  const bookings = await Booking.find({ customer: customer._id }).sort({ startAt: -1 }).limit(100);

  const sessionIds = bookings.map((b) => b.session).filter(Boolean);
  const sessions = await Session.find({ _id: { $in: sessionIds } }).select("status startedAt endedAt durationSeconds");
  const sessionsById = new Map(sessions.map((s) => [String(s._id), s.toJSON()]));

  const count = (status) => bookings.filter((b) => b.status === status).length;
  return {
    ...customer.toJSON(),
    stats: {
      bookings: bookings.length,
      completed: count("completed"),
      upcoming: count("pending") + count("confirmed"),
      noShows: count("no_show"),
      cancelled: count("cancelled"),
    },
    bookings: bookings.map((booking) => ({
      ...booking.toJSON(),
      sessionInfo: booking.session ? sessionsById.get(String(booking.session)) || null : null,
    })),
  };
}

async function createCustomer(data) {
  return Customer.create(data);
}

async function updateCustomer(id, changes) {
  const customer = await getCustomerById(id);
  Object.assign(customer, changes);
  return customer.save();
}

// No bookings -> really deleted. Has bookings -> archived, so the booking history stays complete.
async function deleteCustomer(id) {
  const customer = await getCustomerById(id);
  const hasBookings = await Booking.exists({ customer: customer._id });

  if (!hasBookings) {
    await customer.deleteOne();
    return { result: "deleted", customer };
  }
  customer.isActive = false;
  await customer.save();
  return { result: "archived", customer };
}

module.exports = { listCustomers, getCustomerById, getCustomerWithHistory, createCustomer, updateCustomer, deleteCustomer };
