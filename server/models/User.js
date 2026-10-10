// The "users" collection: people who can log in (Phase 8).
// Passwords are NEVER stored - only a scrypt hash, which is also never sent to the browser.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const ROLES = ["admin", "staff", "cashier"];

// Usernames are stored trimmed + lowercase, so "Ali", " ali " and "ALI" are the same account
function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Name is required"], trim: true, minlength: 2, maxlength: 60 },
    username: {
      type: String,
      required: [true, "Username is required"],
      set: normalizeUsername,
      match: [/^[a-z0-9._-]{3,30}$/, "Username must be 3-30 letters, numbers, dots, dashes or underscores"],
    },
    // select: false -> never loaded unless asked for explicitly (only by the login code)
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: { values: ROLES, message: "Role must be one of: " + ROLES.join(", ") }, required: true },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },

    // Audit: which admin created / last changed this account
    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ role: 1, active: 1 }); // fast "how many active admins?" check

userSchema.plugin(cleanJson);
// Belt and braces: even if a hash was loaded, it is removed from JSON
const baseTransform = userSchema.get("toJSON").transform;
userSchema.set("toJSON", {
  ...userSchema.get("toJSON"),
  transform(document, json) {
    const clean = baseTransform(document, json);
    delete clean.passwordHash;
    return clean;
  },
});

const User = mongoose.model("User", userSchema);

module.exports = { User, ROLES, normalizeUsername };
