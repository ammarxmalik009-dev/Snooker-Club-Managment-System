// The "players" collection (Phase 11.2): REGISTERED players.
//
//  - Separate from Customer (bookings): a player is never created from, linked to, or guessed from a
//    customer, an old bill name or a café "who had it" text.
//  - Walk-in players are NOT stored here: matches (Phase 11.4) keep their name only.
//  - Names are unique among registered players without looking at capitals or extra spaces
//    ("Ali" = " ali "), also against inactive players.
//  - Never deleted: a player is deactivated, so matches and bills can always point back to them.
//  - No counters (games, wins, spending...): those are worked out from match and bill history later.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");
const { nameKeyOf } = require("./Category");

const PLAYER_NAME = { min: 2, max: 60 };

const playerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Player name is required"],
      trim: true,
      minlength: [PLAYER_NAME.min, `Name must be ${PLAYER_NAME.min} to ${PLAYER_NAME.max} characters`],
      maxlength: [PLAYER_NAME.max, `Name must be ${PLAYER_NAME.min} to ${PLAYER_NAME.max} characters`],
    },
    nameKey: { type: String, required: true }, // "  Ali  Khan " -> "ali khan" (the uniqueness rule)
    phone: { type: String, trim: true, maxlength: 20, default: "" },
    phoneDigits: { type: String, default: "" }, // digits only, for searching
    notes: { type: String, trim: true, maxlength: 200, default: "" },

    isActive: { type: Boolean, default: true },
    deactivatedAt: { type: Date, default: null },

    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

playerSchema.pre("validate", function fillKeys() {
  this.nameKey = nameKeyOf(this.name);
  this.phoneDigits = (this.phone || "").replace(/\D/g, "");
});

// One registered player per name (any capitals) - the database itself refuses a second one
playerSchema.index({ nameKey: 1 }, { unique: true });
playerSchema.index({ isActive: 1, nameKey: 1 }); // lists and pickers: active players by name
playerSchema.index({ phoneDigits: 1 });          // search by phone

playerSchema.plugin(cleanJson);
playerSchema.set("toJSON", {
  ...playerSchema.get("toJSON"),
  transform(document, json) {
    const { _id, id, nameKey, phoneDigits, ...rest } = json;
    return { id: String(_id), ...rest };
  },
});

const Player = mongoose.model("Player", playerSchema);

module.exports = { Player, PLAYER_NAME };
