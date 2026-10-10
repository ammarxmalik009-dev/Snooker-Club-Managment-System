// The "authsessions" collection: one document per logged-in browser.
// The browser holds a random token in an httpOnly cookie; here we keep only an HMAC of it
// (so a database leak doesn't reveal usable tokens). Deleting the document = logged out.

const mongoose = require("mongoose");

const authSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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
