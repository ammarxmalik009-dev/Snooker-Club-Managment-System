// The "sessions" collection: one document each time a table is played on.
// A session is "active" while the clock runs, and "completed" once it has ended.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const SESSION_STATUSES = ["active", "completed"];

const sessionSchema = new mongoose.Schema(
  {
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },

    // Copies ("snapshots") taken when the session starts. If the table is renamed,
    // renumbered, re-priced or deleted later, the history still shows what was true then.
    tableNumber: { type: Number, required: true },
    tableName: { type: String, default: "" },
    hourlyRateAtStart: { type: Number, required: true, min: 0 }, // paisa (snapshot of the table rate)

    // Set when the session was started by checking in a booking (Phase 7)
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },

    status: {
      type: String,
      enum: { values: SESSION_STATUSES, message: "Status must be one of: " + SESSION_STATUSES.join(", ") },
      default: "active",
    },

    // true only while the session is running. A special unique index (below) uses it
    // so the DATABASE refuses a second running session on the same table.
    isOpen: { type: Boolean, default: true },

    // Set by the server clock (never by the browser). Stored in UTC.
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date, default: null },

    // Calculated by the server when the session ends
    durationSeconds: { type: Number, default: null, min: 0 },

    // Audit (Phase 8): who started / ended the session
    startedBy: { type: actorSchema, default: null },
    endedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

// Rule: at most ONE open session per table. "partialFilterExpression" means the
// uniqueness only applies to documents where isOpen is true - finished sessions don't count.
sessionSchema.index(
  { table: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: "one_open_session_per_table" }
);
// Phase 11.8: "the sessions running now" (Tables page, Dashboard, every few seconds), oldest first.
// The index above can't answer it (its key is the table), so without this one MongoDB would read
// every session ever played. Partial: it only holds the few OPEN sessions, so it stays tiny.
sessionSchema.index({ startedAt: 1 }, { partialFilterExpression: { isOpen: true }, name: "open_sessions_by_start" });
// Fast history lists (newest first) and date filters
sessionSchema.index({ status: 1, startedAt: -1 });
// Phase 9: "which sessions were running during this period?" (table utilization) and the
// dashboard's "recent sessions" (newest finished first) both look sessions up by end time
sessionSchema.index({ status: 1, endedAt: -1 });

sessionSchema.pre("validate", function checkEndAfterStart() {
  if (this.endedAt && this.endedAt < this.startedAt) {
    this.invalidate("endedAt", "End time cannot be before the start time");
  }
});

sessionSchema.plugin(cleanJson);

const Session = mongoose.model("Session", sessionSchema);

module.exports = { Session, SESSION_STATUSES };
