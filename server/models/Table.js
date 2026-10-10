// The "tables" collection: one document per snooker table in the club.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");

const TABLE_STATUSES = ["available", "occupied", "reserved", "maintenance"];

const tableSchema = new mongoose.Schema(
  {
    tableNumber: {
      type: Number,
      required: [true, "Table number is required"],
      min: [1, "Table number must be at least 1"],
      max: [999, "Table number must be at most 999"],
      validate: { validator: Number.isInteger, message: "Table number must be a whole number" },
    },

    // Optional display name, e.g. "VIP Table" or "Championship Table"
    name: {
      type: String,
      trim: true,
      maxlength: [50, "Name must be at most 50 characters"],
      default: "",
    },

    // Money is stored as a whole number of paisa: Rs 600.00 -> 60000 (see ARCHITECTURE.md §5.1)
    hourlyRate: {
      type: Number,
      required: [true, "Hourly rate is required"],
      min: [0, "Hourly rate cannot be negative"],
      max: [10_000_000, "Hourly rate is too high"],
      validate: { validator: Number.isInteger, message: "Hourly rate must be a whole number of paisa" },
    },

    // From Phase 4, "occupied" will be set automatically when a session starts/stops
    status: {
      type: String,
      enum: { values: TABLE_STATUSES, message: "Status must be one of: " + TABLE_STATUSES.join(", ") },
      default: "available",
    },
  },
  { timestamps: true } // adds createdAt and updatedAt automatically
);

// Two tables can never have the same number - the database itself enforces this
tableSchema.index({ tableNumber: 1 }, { unique: true });
// Makes "show me all available tables" fast
tableSchema.index({ status: 1 });

tableSchema.plugin(cleanJson);

const Table = mongoose.model("Table", tableSchema);

module.exports = { Table, TABLE_STATUSES };
