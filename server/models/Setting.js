// The "settings" collection holds ONE document with the club's billing settings:
// the club-wide rate list, the time-rounding rule and tax. Admins edit it on the
// Settings page - nothing here is hard-coded into bills (each bill keeps a copy).

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const { GAME_MODES } = require("../config/gameModes");

const MAX_PRICE = 10_000_000; // paisa = Rs 100,000.00

const wholeNumber = (label) => ({
  validator: Number.isInteger,
  message: `${label} must be a whole number`,
});

// Phase 11.3: one rate per game mode (paisa per the mode's rateUnit - see config/gameModes.js).
// NO schema defaults on purpose: a missing value means "never set", and the registry then
// supplies the rate (legacy field, else the default). Old settings documents need no migration.
const gameRatesDefinition = Object.fromEntries(GAME_MODES.map((mode) => [
  mode.key,
  { type: Number, min: 0, max: MAX_PRICE, validate: wholeNumber(`${mode.label} rate`) },
]));

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, default: "club" },

    // ---- Rate list (Phase 11.3): gameRates.century (per minute), .frame, .snooker_point, .four_player ----
    // 0 = switched off: bills can't be created for that mode.
    gameRates: gameRatesDefinition,

    // ---- Old rate fields (Phases 5-11.2), kept so nothing stored is lost ----
    // centuryPrice: the old price per century GAME. Century is now charged per minute
    //               (gameRates.century), so this is no longer used for new bills.
    // framePrice:   kept in step with gameRates.frame; used as the Frame rate on old documents
    //               where gameRates.frame was never set.
    centuryPrice: { type: Number, default: 0, min: 0, max: MAX_PRICE, validate: wholeNumber("Century price") },
    framePrice: { type: Number, default: 0, min: 0, max: MAX_PRICE, validate: wholeNumber("Frame price") },

    // ---- Time rule: minimum minutes, then round up to the next step ----
    minimumBillableMinutes: { type: Number, default: 15, min: 1, max: 240, validate: wholeNumber("Minimum minutes") },
    billingIncrementMinutes: { type: Number, default: 5, min: 1, max: 60, validate: wholeNumber("Rounding step") },

    // ---- Tax: off for now; can be switched on later without code changes ----
    taxEnabled: { type: Boolean, default: false },
    taxRateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000, validate: wholeNumber("Tax rate") }, // 1600 = 16%

    // ---- Bookings: minutes after the start time before an un-checked-in booking becomes a no-show ----
    noShowGraceMinutes: { type: Number, default: 15, min: 5, max: 120, validate: wholeNumber("No-show minutes") },

    currency: { type: String, default: "PKR" },

    // ---- Backups: an XML file of the whole database every N hours (folder: BACKUP_DIR in .env) ----
    backupEnabled: { type: Boolean, default: true },
    backupIntervalHours: { type: Number, default: 12, min: 1, max: 168, validate: wholeNumber("Backup interval") },
    backupKeepCount: { type: Number, default: 30, min: 1, max: 365, validate: wholeNumber("Backups to keep") },
    // Status, written by the backup service (never by PATCH /api/settings)
    lastBackupAt: { type: Date, default: null },
    lastBackupFile: { type: String, default: null },
    lastBackupAttemptAt: { type: Date, default: null },
    lastBackupError: { type: String, default: null },

    // Audit (Phase 8): the admin who last changed the settings
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

settingSchema.index({ key: 1 }, { unique: true });
settingSchema.plugin(cleanJson);

const Setting = mongoose.model("Setting", settingSchema);

module.exports = { Setting, MAX_PRICE, BACKUP_LIMITS: { minHours: 1, maxHours: 168, minKeep: 1, maxKeep: 365 } };
