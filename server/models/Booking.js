// The "bookings" collection: a table reserved for a customer for a time slot.
//
//   pending   -> booked, not confirmed yet
//   confirmed -> confirmed with the customer
//   completed -> the customer arrived and was checked in (a session was started)
//   cancelled -> cancelled by staff
//   no_show   -> nobody came: set automatically a few minutes after the start time
//
// Only pending/confirmed bookings block the table's time slot.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const BOOKING_STATUSES = ["pending", "confirmed", "completed", "cancelled", "no_show"];
const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed"]; // still "holding" the slot

const bookingSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },

    // Copies for history (the customer or table may be renamed or removed later)
    customerName: { type: String, required: true },
    customerPhone: { type: String, default: "" },
    tableNumber: { type: Number, required: true },
    tableName: { type: String, default: "" },

    // Stored in UTC; entered and shown in the club's timezone
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },

    status: {
      type: String,
      enum: { values: BOOKING_STATUSES, message: "Status must be one of: " + BOOKING_STATUSES.join(", ") },
      default: "pending",
    },
    notes: { type: String, trim: true, maxlength: 200, default: "" },

    // Filled in as the booking moves on
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", default: null },
    checkedInAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, maxlength: 200, default: "" },
    noShowAt: { type: Date, default: null },

    // Audit (Phase 8)
    createdBy: { type: actorSchema, default: null },
    cancelledBy: { type: actorSchema, default: null },
    checkedInBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

bookingSchema.pre("validate", function checkTimes() {
  if (this.startAt && this.endAt && this.endAt <= this.startAt) {
    this.invalidate("endAt", "The end time must be after the start time");
  }
});

// Fast overlap checks (same table, time range) and day lists
bookingSchema.index({ table: 1, startAt: 1, endAt: 1 });
bookingSchema.index({ status: 1, startAt: 1 });
bookingSchema.index({ customer: 1, startAt: -1 });

bookingSchema.plugin(cleanJson);

const Booking = mongoose.model("Booking", bookingSchema);

module.exports = { Booking, BOOKING_STATUSES, ACTIVE_BOOKING_STATUSES };
