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

// A logged-in user's own identity, preferring `.id` over `._id` - deliberately a small, local
// copy of models/schemas/actor.js's own identityOf (same precedence rule, same reasoning: a
// real Mongoose document always has BOTH `._id` and a `.id` virtual that is exactly
// `String(_id)`, confirmed directly, never a separate or stale value; a PostgreSQL-shaped user
// - every *.pg.service.js's own mapUserRow - has ONLY `.id`). Not an import of that file, which
// requires "mongoose" just to define its own (unused, for this purpose) Mongoose sub-schema -
// pulling it in here would put mongoose back into every PostgreSQL pilot's require chain, the
// same isolation reason actorFrom below is already its own small copy, not an import.
function identityOf(user) {
  if (typeof user.id === "string" && user.id) return user.id;
  return user._id;
}

// The flip side of actorFromRow: a logged-in user -> { user, name, username } to WRITE into the
// flattened actor columns. Deliberately a small, local copy of
// models/schemas/actor.js's actorFrom, not an import of it - that file requires "mongoose" just
// to define its (unused, for this purpose) Mongoose sub-schema, and pulling it in here would put
// mongoose back into every PostgreSQL pilot's require chain, undoing the isolation step 2.4
// intended (and step 2.5 corrected: the original isolation test only checked DIRECT require
// children, which happened to hide this exact gap - see docs/POSTGRES_MIGRATION.md, step 2.5).
//
// Uses identityOf (above), not `user._id` directly - found and fixed during Phase 3's own
// integration-readiness audit: a PostgreSQL-shaped actorUser has no `._id` at all, only `.id`,
// so the old direct access silently produced `user: undefined` for that shape. actorUserIdOrNull
// (below) happened to turn that into the same harmless `null` a non-UUID MongoDB id already
// produces today, so this was never a crash - but it was still the wrong value for the one case
// that actually matters (a real PostgreSQL-authoritative actor), not merely a cosmetic gap.
function actorFrom(user) {
  return user ? { user: identityOf(user), name: user.name, username: user.username } : null;
}

// Until Phase 3 ports Users to PostgreSQL, a logged-in person's real id is a MongoDB ObjectId
// (24 hex characters), never a PostgreSQL uuid - storing it in a uuid column that's a foreign
// key to app.users (which has no real rows yet) would either fail the type or the FK itself
// (confirmed directly: a uuid-SHAPED but non-existent id is correctly refused - step 2.4). Every
// *_user_id column uses this before it ever reaches a query: only a value already shaped like a
// uuid is attempted; anything else (every real actor today) becomes null, while the readable
// name/username (actorFromRow above) are still stored and returned.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function actorUserIdOrNull(value) {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

module.exports = { toMoney, snakeToCamel, toId, actorFromRow, actorFrom, actorUserIdOrNull, identityOf };
