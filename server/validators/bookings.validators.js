// Input rules for the /api/bookings endpoints.
// Times are club-local: date "2026-10-07", startTime "18:30" (15-minute steps), durationMinutes 30-480.

const { body, param, query } = require("express-validator");
const { BOOKING_STATUSES } = require("../models/Booking");
const { PHONE_PATTERN } = require("./customers.validators");

function isCalendarDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

// "18:30" - hours 00-23, minutes 00/15/30/45
const TIME_PATTERN = /^([01]\d|2[0-3]):(00|15|30|45)$/;

const idRules = [param("id").isMongoId().withMessage("Invalid booking id")];

function timeRules(required) {
  const field = (name, label) => {
    const chain = body(name);
    return required ? chain.exists({ values: "falsy" }).withMessage(`${label} is required`).bail() : chain.optional();
  };
  return [
    field("date", "Date").custom(isCalendarDate).withMessage("Date must be a date like 2026-10-07"),
    field("startTime", "Start time").matches(TIME_PATTERN).withMessage("Start time must be like 18:30 (every 15 minutes)"),
    field("durationMinutes", "Duration").isInt({ min: 30, max: 480 }).withMessage("Duration must be from 30 minutes to 8 hours").bail()
      .toInt().custom((minutes) => minutes % 15 === 0).withMessage("Duration must be in 15-minute steps"),
  ];
}

const notesRule = () =>
  body("notes").optional({ values: "null" }).isString().bail().trim().isLength({ max: 200 }).withMessage("Notes must be at most 200 characters");

const createRules = [
  body("tableId").exists({ values: "falsy" }).withMessage("Choose a table").bail().isMongoId().withMessage("Invalid table id"),
  // Either an existing customer, or a new one
  body().custom((data) => Boolean(data && (data.customerId || data.newCustomer)))
    .withMessage("Choose a customer or add a new one"),
  body("customerId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid customer id"),
  body("newCustomer").optional({ values: "null" }).isObject().withMessage("New customer must have a name"),
  body("newCustomer.name").if(body("newCustomer").exists({ values: "null" }))
    .isString().withMessage("Customer name is required").bail()
    .trim().isLength({ min: 2, max: 60 }).withMessage("Customer name must be 2 to 60 characters"),
  body("newCustomer.phone").if(body("newCustomer").exists({ values: "null" }))
    .optional({ values: "null" }).isString().bail().trim()
    .custom((phone) => phone === "" || PHONE_PATTERN.test(phone))
    .withMessage("Phone must be 7 to 20 digits (spaces, - and a leading + are allowed)"),
  ...timeRules(true),
  body("status").optional({ values: "falsy" }).isIn(["pending", "confirmed"]).withMessage("A new booking is pending or confirmed"),
  notesRule(),
];

const updateRules = [
  ...idRules,
  body().custom((data) => Boolean(data) && ["tableId", "date", "startTime", "durationMinutes", "notes"].some((f) => f in data))
    .withMessage("Send at least one field to change"),
  body("tableId").optional().isMongoId().withMessage("Invalid table id"),
  ...timeRules(false),
  notesRule(),
];

const cancelRules = [
  ...idRules,
  body("reason").optional({ values: "null" }).isString().bail().trim().isLength({ max: 200 }).withMessage("Reason must be at most 200 characters"),
];

const listRules = [
  query("date").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("Date must be a date like 2026-10-07"),
  query("from").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("From date must be a date like 2026-10-07"),
  query("to").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("To date must be a date like 2026-10-07")
    .custom((to, { req }) => {
      if (isCalendarDate(req.query.from) && to < req.query.from) throw new Error("To date cannot be before the From date");
      return true;
    }),
  query("status").optional({ values: "falsy" }).isIn([...BOOKING_STATUSES, "active"])
    .withMessage("Status filter must be one of: " + [...BOOKING_STATUSES, "active"].join(", ")),
  query("tableId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid table id"),
  query("customerId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid customer id"),
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 200 }).withMessage("Limit must be from 1 to 200").toInt(),
];

const availabilityRules = [
  query("date").exists({ values: "falsy" }).withMessage("Choose a date").bail().custom(isCalendarDate).withMessage("Date must be a date like 2026-10-07"),
];

module.exports = { idRules, createRules, updateRules, cancelRules, listRules, availabilityRules };
