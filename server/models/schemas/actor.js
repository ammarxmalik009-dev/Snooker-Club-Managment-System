// "Who did it" - stored on bills, payments, bookings, sessions, settings and users.
// A reference to the user PLUS a copy of their name, so history stays readable even if
// the account is later renamed or deactivated.

const mongoose = require("mongoose");

const actorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    username: { type: String, required: true },
  },
  { _id: false }
);

// req.user -> { user, name, username }  (or null when there is no logged-in user, e.g. scripts)
function actorFrom(user) {
  return user ? { user: user._id, name: user.name, username: user.username } : null;
}

module.exports = { actorSchema, actorFrom };
