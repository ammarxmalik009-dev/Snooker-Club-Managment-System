// The "authsessions" collection: one document per logged-in browser.
// The browser holds a random token in an httpOnly cookie; here we keep only an HMAC of it
// (so a database leak doesn't reveal usable tokens). Deleting the document = logged out.

const mongoose = require("mongoose");
const { isValidActorIdentity } = require("./schemas/actor");

const authSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    // String, not ObjectId - the same Phase 3 identity-compatibility change as
    // models/schemas/actor.js's own `user` field, and for the same verified reasons (see that
    // file's own comment). An existing ObjectId value casts to this type unchanged, so every
    // session MongoDB creates today is unaffected.
    //
    // IMPORTANT, NOT assumed: this type change alone does NOT make MongoDB and PostgreSQL
    // sessions interchangeable. server/services/auth.service.js's own `resolveSession` still
    // does `User.findById(session.user)` - a real MongoDB query that only works when
    // `session.user` is actually a MongoDB ObjectId (hex string or instance). A session whose
    // `user` held a PostgreSQL UUID would still fail that specific lookup; fixing THAT is a
    // business-logic change to auth.service.js itself, explicitly out of this step's scope
    // (schema/validator compatibility only). Today, every real session's `user` is still a
    // genuine MongoDB ObjectId, so this remains exactly as correct as before this change.
    user: {
      type: String,
      required: true,
      validate: { validator: isValidActorIdentity, message: "user must be a valid id" },
    },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: "", maxlength: 300 },
    ip: { type: String, default: "", maxlength: 64 },
  },
  { timestamps: true }
);

authSessionSchema.index({ tokenHash: 1 }, { unique: true });
authSessionSchema.index({ user: 1 });
// MongoDB deletes expired sessions by itself (TTL index)
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AuthSession = mongoose.model("AuthSession", authSessionSchema);

module.exports = { AuthSession };
