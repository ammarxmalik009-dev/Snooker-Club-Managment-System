// Small, reusable conversions between PostgreSQL rows and the JSON shapes the API already
// sends (Phase 2, step 2.4). Built only for what the Settings pilot actually needs - add to this
// file only when a later model's own mapper hits the SAME real conversion, not speculatively.

// PostgreSQL "bigint" columns (every money column in this schema: paisa) come back from the `pg`
// driver as STRINGS, never numbers - confirmed directly, not assumed:
//   SELECT 1000::bigint  ->  { }  the JS value is the STRING "1000", typeof "string"
// (the driver's own deliberate choice: a JS number can't safely hold the full 64-bit range).
// The app's amounts never exceed MAX_PRICE (10,000,000 paisa, see models/Setting.js), far below
// Number.MAX_SAFE_INTEGER, so converting back to a plain number loses nothing.
// null is passed through AS null (never coerced to 0 or vice versa): in this schema NULL means
// "never set" and 0 means "explicitly set to zero" (Setting.js: a rate of 0 switches a game mode
// off) - two different, real meanings that must never collapse into each other.
function toMoney(value) {
  return value === null || value === undefined ? null : Number(value);
}

// snake_case -> camelCase, for ordinary one-to-one columns only (e.g. minimum_billable_minutes
// -> minimumBillableMinutes). A column that needs RESHAPING - nesting or renaming into a
// different structure, like this schema's four rate_* columns becoming one gameRates object -
// is mapped explicitly by that model's own mapper instead; this helper never guesses at that.
function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

// uuid columns already come back from `pg` as plain strings (confirmed directly: SELECT
// gen_random_uuid() returns a JS string). This exists only to name that conversion explicitly -
// one place to change it if that ever stops being true - the same way models/plugins/cleanJson.js
// names Mongo's ObjectId -> string conversion today, rather than relying on it silently.
function toId(value) {
  return value === null || value === undefined ? null : String(value);
}

// The "who did it" actor columns (<prefix>_user_id/_name/_username - server/db/migrations
// /0001_initial_schema.sql's flattened form of Mongoose's embedded actorSchema) back into the
// same { user, name, username } shape the API already returns, or null if no actor was recorded
// at all. Checked on name/username, NOT on user_id alone: until Phase 3 ports Users to
// PostgreSQL, a real actor's user_id is stored as null (it is a MongoDB ObjectId, not a
// PostgreSQL uuid - see server/services/settings.pg.service.js's actorUserIdOrNull), while their
// name and username ARE still known and worth keeping for a readable audit trail. Mongoose's
// embedded actorSchema never has "name known, user unknown" as a possible state (actorFrom sets
// all three together) - this extra case only exists because of this interim id gap.
function actorFromRow(row, prefix) {
  const name = row[`${prefix}_name`];
  const username = row[`${prefix}_username`];
  if (name === null && username === null) return null; // no actor was recorded at all (e.g. a script)
  return { user: toId(row[`${prefix}_user_id`]), name, username };
}

module.exports = { toMoney, snakeToCamel, toId, actorFromRow };
