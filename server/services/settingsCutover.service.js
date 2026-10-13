// Settings - the Group 1 cutover adapter (Phase 3). GET/PATCH /api/settings call this instead
// of server/services/settings.service.js directly; this is the ONLY code change the route or
// controller needed. Chooses MongoDB (the default, today's exact behaviour) or PostgreSQL (once
// PG_CUTOVER_ROUTES names "settings" - server/config/cutover.js) as the authoritative backend,
// per request, with no shared transaction across the two databases and no silent dual-write or
// fallback. See docs/POSTGRES_MIGRATION.md's Phase 3 Group 1 section for the full design and the
// documented manual rollback procedure.
//
// The four backup-STATUS fields (lastBackupAt, lastBackupFile, lastBackupAttemptAt,
// lastBackupError) are DELIBERATELY ALWAYS read from MongoDB, regardless of which database is
// authoritative for everything else: server/services/backup.service.js writes them straight to
// the MongoDB Setting document, completely outside this route's own PATCH path, and a
// PostgreSQL equivalent of the backup system itself is a separate, later, gated milestone
// (Phase 3 Group 8 - PostgreSQL backup/restore), not this one. Treating those four fields as
// PostgreSQL-authoritative here would show permanently stale values the moment PostgreSQL
// becomes authoritative for Settings - exactly the "falsely claiming both databases are
// consistent" this design must avoid, not a hidden bug to fix later.
//
// No write to PostgreSQL ever happens while MongoDB is authoritative, and vice versa: each
// branch below calls exactly one backend's own, already-tested service function, never both,
// and never catches a failure from the chosen one to retry on the other - a failed write stays
// failed and is reported to the caller as such (verified directly: see
// server/tests/settingsCutover.test.js's own "no silent fallback" tests).

const { isPgAuthoritative } = require("../config/cutover");
const mongoSettings = require("./settings.service");
const pgSettings = require("./settings.pg.service");
const { Setting } = require("../models/Setting");

const ROUTE_GROUP = "settings";
const BACKUP_STATUS_FIELDS = ["lastBackupAt", "lastBackupFile", "lastBackupAttemptAt", "lastBackupError"];
// The same fields describeSettings/updateSettings compare, EXCLUDING the backup-status fields
// above (which are never PostgreSQL-authoritative, so comparing them would only ever report the
// permanent, expected gap documented above, not a real divergence worth flagging).
const COMPARABLE_FIELDS = [
  "centuryPrice", "framePrice", "minimumBillableMinutes", "billingIncrementMinutes",
  "taxEnabled", "taxRateBasisPoints", "noShowGraceMinutes",
  "backupEnabled", "backupIntervalHours", "backupKeepCount",
];
const GAME_RATE_KEYS = ["century", "frame", "snooker_point", "four_player"];

async function backupStatusFromMongo() {
  const doc = await mongoSettings.getSettings(); // same upsert-if-missing call the Mongo path itself uses - never creates a second document
  const plain = doc.toJSON();
  const status = {};
  for (const field of BACKUP_STATUS_FIELDS) status[field] = plain[field] ?? null;
  return status;
}

async function getSettings() {
  if (!isPgAuthoritative(ROUTE_GROUP)) return mongoSettings.getSettings();
  const [settings, backupStatus] = await Promise.all([pgSettings.getSettings(), backupStatusFromMongo()]);
  return { ...settings, ...backupStatus };
}

// Mongo's own describeSettings expects a Mongoose document (it calls .toJSON() itself); the PG
// path's getSettings()/updateSettings() above already return a plain object (backup-status
// fields included), which pgSettings.describeSettings accepts directly - each branch uses
// exactly the shape its own, already-tested describeSettings was built for.
function describeSettings(settings) {
  if (!isPgAuthoritative(ROUTE_GROUP)) return mongoSettings.describeSettings(settings);
  return pgSettings.describeSettings(settings);
}

async function updateSettings(changes, actorUser = null) {
  if (!isPgAuthoritative(ROUTE_GROUP)) return mongoSettings.updateSettings(changes, actorUser);
  const updated = await pgSettings.updateSettings(changes, actorUser); // propagates any failure untouched - no catch, no MongoDB fallback
  const backupStatus = await backupStatusFromMongo();
  return { ...updated, ...backupStatus };
}

// Read-only reconciliation: reports whether MongoDB's and PostgreSQL's own copies of Settings
// currently agree, field by field, WITHOUT changing either one. Deliberately not a background
// worker (per this group's own scope: no sync automation without a designed retry/idempotency/
// conflict-resolution/monitoring story, which is explicitly out of scope here) - this is meant
// to be called manually (or by a future monitoring job) before a rollback, or at any time to
// check the two databases haven't drifted apart while one of them was authoritative.
async function reconcileSettings() {
  const mongoDoc = await mongoSettings.getSettings();
  const mongoPlain = mongoDoc.toJSON();

  let pgPlain;
  try {
    pgPlain = await pgSettings.getSettings();
  } catch (error) {
    return { checked: false, reason: `Could not read PostgreSQL settings: ${error.message}` };
  }

  const differences = [];
  for (const field of COMPARABLE_FIELDS) {
    const mongoValue = mongoPlain[field] ?? null;
    const pgValue = pgPlain[field] ?? null;
    if (mongoValue !== pgValue) differences.push({ field, mongo: mongoValue, postgres: pgValue });
  }
  for (const key of GAME_RATE_KEYS) {
    const mongoValue = (mongoPlain.gameRates && mongoPlain.gameRates[key]) ?? null;
    const pgValue = pgPlain.gameRates[key] ?? null;
    if (mongoValue !== pgValue) differences.push({ field: `gameRates.${key}`, mongo: mongoValue, postgres: pgValue });
  }

  return { checked: true, inSync: differences.length === 0, differences };
}

module.exports = { getSettings, describeSettings, updateSettings, reconcileSettings, ROUTE_GROUP };
