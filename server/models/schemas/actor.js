// "Who did it" - stored on bills, payments, bookings, sessions, settings and users.
// A reference to the user PLUS a copy of their name, so history stays readable even if
// the account is later renamed or deactivated.
//
// user's type is `String`, not `mongoose.Schema.Types.ObjectId` - a deliberate Phase 3
// identity-compatibility change (PostgreSQL migration), verified directly, not guessed:
//   - Every actor written so far is a real MongoDB ObjectId (24 hex characters). Assigning an
//     ObjectId instance to a String-typed field casts it to that exact same hex string
//     automatically (confirmed directly against this Mongoose version before relying on it) -
//     so every historical document, and every value actorFrom() below has ever produced,
//     serializes and reads back completely unchanged.
//   - A PostgreSQL-authoritative user's id is a UUID (36 characters, hyphenated) - the strict
//     ObjectId type used to reject this outright with a CastError (confirmed directly:
//     `new mongoose.Types.ObjectId(uuidString)` throws "input must be a 24 character hex
//     string..."). String has no such cast, so a UUID now simply IS the value.
//   - `Schema.Types.Mixed` was considered and rejected: it would accept malformed, arbitrary
//     values too (no cast, no validation), failing the actual requirement ("reject malformed
//     IDs where the schema contract requires a valid identity"). `String` plus the explicit
//     isValidActorIdentity validator below is the narrower of the two options that still
//     accepts both real identity formats.
//   - `ref: "User"` is removed along with the ObjectId type - nothing in this codebase calls
//     `.populate()` on any actor field (confirmed by search), so this changes no existing
//     behaviour. A reference that can point at a row in either database can't be a Mongoose
//     `ref` anyway (that always means "a MongoDB collection").
// `required: true` is UNCHANGED for `user` - this only loosens its TYPE, never its presence.

const mongoose = require("mongoose");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A valid identity is a real MongoDB ObjectId (today's only actual case) OR a real PostgreSQL
// UUID (not yet produced by anything active, but accepted here so the schema is ready before
// any route is). Anything else (empty, malformed, an arbitrary string) is rejected - this is
// the ONE place that decision is made, reused by the matching HTTP-level id validator
// (server/validators/auth.validators.js) so the two can never quietly disagree.
function isValidActorIdentity(value) {
  return mongoose.Types.ObjectId.isValid(value) || UUID_PATTERN.test(String(value));
}

const actorSchema = new mongoose.Schema(
  {
    user: {
      type: String,
      required: true,
      validate: { validator: isValidActorIdentity, message: "user must be a valid id" },
    },
    name: { type: String, required: true },
    username: { type: String, required: true },
  },
  { _id: false }
);

// req.user -> { user, name, username }  (or null when there is no logged-in user, e.g. scripts).
//
// Precedence rule for the identity, when both `id` and `_id` might exist - documented here
// explicitly, not left implicit, because getting this wrong either way has a real consequence
// (Phase 3, Group 2's own integration audit found this exact gap):
//
//   PREFER `user.id` (a non-empty string) OVER `user._id`.
//
// This is safe, not arbitrary, for a verified reason: every real Mongoose document (confirmed
// directly against this project's own User model, not assumed) already has BOTH properties -
// `._id` (the ObjectId instance) AND `.id` (Mongoose's own built-in virtual getter, which always
// computes `String(this._id)` fresh on each access - never a separate, cached, or "stale" copy).
// So for a MongoDB user, `user.id` and `String(user._id)` are the exact same identity, just
// already in the string form this field needs. A PostgreSQL-shaped user object
// (users.pg.service.js's own mapUserRow) has ONLY `.id` - never `._id` at all - so the same
// "prefer id" rule picks the only identity it actually has.
// `._id` is kept only as a fallback for an object that has it but genuinely lacks a usable
// `.id` (defensive, not expected to ever trigger for either of this app's two real user shapes).
// If NEITHER is a usable value, `identityOf` returns `undefined` - never silently invented, so
// the schema's own `required: true` catches it as a real validation error instead of quietly
// writing an actor nobody can trace.
function identityOf(user) {
  if (typeof user.id === "string" && user.id) return user.id;
  return user._id;
}

function actorFrom(user) {
  return user ? { user: identityOf(user), name: user.name, username: user.username } : null;
}

module.exports = { actorSchema, actorFrom, isValidActorIdentity, identityOf };
