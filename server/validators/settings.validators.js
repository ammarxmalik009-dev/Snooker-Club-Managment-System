// Input rules for PATCH /api/settings (all fields optional, at least one required).

const { body } = require("express-validator");
const { MAX_PRICE, BACKUP_LIMITS } = require("../models/Setting");
const { GAME_MODES, ALL_GAME_MODE_KEYS } = require("../config/gameModes");

const FIELDS = ["gameRates", "centuryPrice", "framePrice", "minimumBillableMinutes", "billingIncrementMinutes", "taxEnabled", "taxRateBasisPoints",
                "noShowGraceMinutes", "backupEnabled", "backupIntervalHours", "backupKeepCount"];

const updateRules = [
  body()
    .custom((data) => Boolean(data) && FIELDS.some((name) => name in data))
    .withMessage("Send at least one setting to change: " + FIELDS.join(", ")),
  // Phase 11.3: { gameRates: { century: 1000, frame: 25000, ... } } - any of the registry's modes, paisa
  body("gameRates")
    .optional()
    .custom((rates) => rates !== null && typeof rates === "object" && !Array.isArray(rates) && Object.keys(rates).length > 0)
    .withMessage("Game rates must look like { \"century\": 1000 } (paisa)")
    .bail()
    .custom((rates) => Object.keys(rates).every((key) => ALL_GAME_MODE_KEYS.includes(key)))
    .withMessage(`Game rates can only be set for: ${ALL_GAME_MODE_KEYS.join(", ")}`),
  ...GAME_MODES.map((mode) => body(`gameRates.${mode.key}`)
    .optional()
    .isInt({ min: 0, max: MAX_PRICE })
    .withMessage(`${mode.label} rate must be between Rs 0 and Rs 100,000`)
    .bail()
    .toInt()),
  // Older fields: still accepted. framePrice = the Frame rate; centuryPrice is only stored
  // (Century is charged per minute since Phase 11.3 - see gameRates.century).
  body("centuryPrice").optional().isInt({ min: 0, max: MAX_PRICE }).withMessage("Century price must be between Rs 0 and Rs 100,000").bail().toInt(),
  body("framePrice").optional().isInt({ min: 0, max: MAX_PRICE }).withMessage("Frame price must be between Rs 0 and Rs 100,000").bail().toInt(),
  body("minimumBillableMinutes").optional().isInt({ min: 1, max: 240 }).withMessage("Minimum must be 1 to 240 minutes").bail().toInt(),
  body("billingIncrementMinutes").optional().isInt({ min: 1, max: 60 }).withMessage("Rounding step must be 1 to 60 minutes").bail().toInt(),
  body("taxEnabled").optional().isBoolean({ strict: true }).withMessage("Tax on/off must be true or false").bail().toBoolean(),
  body("taxRateBasisPoints").optional().isInt({ min: 0, max: 10_000 }).withMessage("Tax rate must be between 0% and 100%").bail().toInt(),
  body("noShowGraceMinutes").optional().isInt({ min: 5, max: 120 }).withMessage("No-show time must be 5 to 120 minutes").bail().toInt(),
  // Backups: on/off, every N hours, keep the last N files
  body("backupEnabled").optional().isBoolean({ strict: true }).withMessage("Backup on/off must be true or false").bail().toBoolean(),
  body("backupIntervalHours").optional().isInt({ min: BACKUP_LIMITS.minHours, max: BACKUP_LIMITS.maxHours })
    .withMessage(`Backup time must be ${BACKUP_LIMITS.minHours} to ${BACKUP_LIMITS.maxHours} hours`).bail().toInt(),
  body("backupKeepCount").optional().isInt({ min: BACKUP_LIMITS.minKeep, max: BACKUP_LIMITS.maxKeep })
    .withMessage(`Keep ${BACKUP_LIMITS.minKeep} to ${BACKUP_LIMITS.maxKeep} backups`).bail().toInt(),
];

module.exports = { updateRules };
