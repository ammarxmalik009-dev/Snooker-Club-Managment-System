// Club billing settings - PostgreSQL pilot (Phase 2, step 2.4).
//
// This is a SEPARATE, standalone module: it does not replace, call, or get called by
// server/services/settings.service.js (MongoDB), and nothing in server/app.js, server/server.js
// or any route requires this file. The running application's Settings page keeps working through
// the MongoDB path exactly as before; this module exists to be tested on its own against the
// verified local PostgreSQL (server/tests/postgresSettings.test.js), proving the row-mapper
// layer and the schema from step 2.3 actually work for a real service, one at a time, as the
// Phase 3 roadmap in docs/POSTGRES_MIGRATION.md intends (Settings is first).
//
// Field names, defaults and business rules are the SAME as settings.service.js (MongoDB) - this
// file reuses config/gameModes.js's resolveGameRates (the actual rate-resolution logic) rather
// than re-implementing it, so the two paths can never quietly disagree about what a rate
// resolves to. It uses its own small actorFrom (db/rowMappers.js), not
// models/schemas/actor.js's - that file requires "mongoose" just to define an unused sub-schema,
// which would otherwise put MongoDB back into this pilot's require chain (see rowMappers.js).

const { query } = require("../config/db.pg");
const { toMoney, toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { resolveGameRates } = require("../config/gameModes");
const AppError = require("../utils/AppError");

const SETTINGS_KEY = "club";

// A database row -> the same plain-object shape settings.service.js's Mongoose document
// produces via .toJSON() - so describeSettings() below (and resolveGameRates, shared with the
// MongoDB path) work on it unchanged.
function mapSettingsRow(row) {
  if (!row) return null;
  return {
    id: toId(row.id),
    key: row.key,
    // The four rate_* columns (step 2.3) become ONE nested object - a reshape, not a plain
    // rename, so it is written out explicitly here rather than guessed by a generic mapper.
    gameRates: {
      century: toMoney(row.rate_century),
      frame: toMoney(row.rate_frame),
      snooker_point: toMoney(row.rate_snooker_point),
      four_player: toMoney(row.rate_four_player),
    },
    centuryPrice: toMoney(row.century_price),
    framePrice: toMoney(row.frame_price),
    minimumBillableMinutes: row.minimum_billable_minutes,
    billingIncrementMinutes: row.billing_increment_minutes,
    taxEnabled: row.tax_enabled,
    taxRateBasisPoints: row.tax_rate_basis_points,
    noShowGraceMinutes: row.no_show_grace_minutes,
    currency: row.currency,
    backupEnabled: row.backup_enabled,
    backupIntervalHours: row.backup_interval_hours,
    backupKeepCount: row.backup_keep_count,
    lastBackupAt: row.last_backup_at,
    lastBackupFile: row.last_backup_file,
    lastBackupAttemptAt: row.last_backup_attempt_at,
    lastBackupError: row.last_backup_error,
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Creates the one settings row with every column's default the first time it's needed, and
// NEVER overwrites existing values afterwards - the exact same rule as the MongoDB path's
// upsert + $setOnInsert, using PostgreSQL's own idiom for it: insert, and on the key already
// existing, "update" a column to its own current value (a genuine no-op) so RETURNING * still
// gives back the row either way, in one round trip. Verified race-free directly: 20 concurrent
// calls create exactly one row (see docs/POSTGRES_MIGRATION.md, step 2.4) - the "key" column's
// own UNIQUE constraint (step 2.3) is what actually serializes this, the same role the unique
// index on Setting.js's "key" field plays for MongoDB's upsert today.
async function getSettings() {
  const result = await query(
    `INSERT INTO app.settings (key) VALUES ($1)
     ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
     RETURNING *`,
    [SETTINGS_KEY]
  );
  return mapSettingsRow(result.rows[0]);
}

// Identical to settings.service.js's describeSettings: the stored settings, with gameRates
// replaced by today's EFFECTIVE rates (resolveGameRates - admin value, else legacy field, else
// the registry default). Reusing the same shared function as the MongoDB path, not a copy of it.
function describeSettings(settings) {
  return { ...settings, gameRates: resolveGameRates(settings) };
}

const COLUMN_FOR_FIELD = {
  centuryPrice: "century_price",
  framePrice: "frame_price",
  minimumBillableMinutes: "minimum_billable_minutes",
  billingIncrementMinutes: "billing_increment_minutes",
  taxEnabled: "tax_enabled",
  taxRateBasisPoints: "tax_rate_basis_points",
  noShowGraceMinutes: "no_show_grace_minutes",
  backupEnabled: "backup_enabled",
  backupIntervalHours: "backup_interval_hours",
  backupKeepCount: "backup_keep_count",
};
const RATE_COLUMN_FOR_MODE = { century: "rate_century", frame: "rate_frame", snooker_point: "rate_snooker_point", four_player: "rate_four_player" };

async function updateSettings(changes, actorUser = null) {
  const { gameRates = {}, ...fields } = changes;
  // framePrice (the old field) and gameRates.frame are the same rate - kept in step, and refused
  // if two different values are sent at once. Identical rule to settings.service.js (MongoDB).
  if ("framePrice" in fields && "frame" in gameRates && fields.framePrice !== gameRates.frame) {
    throw new AppError("Send the Frame rate once (gameRates.frame, or the older framePrice)", 400,
      [{ field: "gameRates.frame", message: "Two different Frame rates were sent" }]);
  }
  if ("framePrice" in fields) gameRates.frame = fields.framePrice;
  if ("frame" in gameRates) fields.framePrice = gameRates.frame;

  await getSettings(); // make sure the row exists before trying to UPDATE it

  const setClauses = [];
  const values = [];
  const setColumn = (column, value) => { values.push(value); setClauses.push(`${column} = $${values.length}`); };

  for (const [field, column] of Object.entries(COLUMN_FOR_FIELD)) {
    if (field in fields) setColumn(column, fields[field]);
  }
  for (const [modeKey, amount] of Object.entries(gameRates)) {
    const column = RATE_COLUMN_FOR_MODE[modeKey];
    if (column) setColumn(column, amount); // an unknown mode key is already rejected by the shared validators before this ever runs
  }

  const actor = actorFrom(actorUser);
  setColumn("updated_by_user_id", actor ? actorUserIdOrNull(String(actor.user)) : null);
  setColumn("updated_by_name", actor ? actor.name : null);
  setColumn("updated_by_username", actor ? actor.username : null);
  setClauses.push("updated_at = now()");

  values.push(SETTINGS_KEY);
  const result = await query(`UPDATE app.settings SET ${setClauses.join(", ")} WHERE key = $${values.length} RETURNING *`, values);
  return mapSettingsRow(result.rows[0]);
}

module.exports = { getSettings, describeSettings, updateSettings, mapSettingsRow, SETTINGS_KEY };
