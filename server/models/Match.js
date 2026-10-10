// The "matches" collection (Phase 11.4): one game played during a session.
//
//   Table -> Session -> Match -> Players -> Result -> Bill (Phase 11.5) -> Payment
//
//  - Every match belongs to ONE session; a session can have MANY matches (#1, #2, #3 ...).
//    One frame = one match: another frame is another match.
//  - The session is the clock. A match has no timer and no price: the bill (Phase 11.5) works
//    out the time and copies the rate when it is created.
//  - Players: a registered player (reference + a copy of the name) or a walk-in (name only).
//    Walk-ins never create Player or Customer records.
//  - No counters (wins, losses...): player statistics are worked out from these records (player history 11.6, reports 11.7).
//  - Matches are never deleted: a match is completed or cancelled and stays in the history.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");
const { ALL_GAME_MODE_KEYS } = require("../config/gameModes");

const MATCH_STATUSES = ["in_progress", "completed", "cancelled"];
const PLAYER_RESULTS = ["winner", "loser"];
const MATCH_PLAYER_NAME_MAX = 60; // registered names can be 60 characters (Player model)

const matchPlayerSchema = new mongoose.Schema(
  {
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null }, // null = walk-in
    name: { type: String, required: true, trim: true, maxlength: MATCH_PLAYER_NAME_MAX }, // copy at the start of the match
    seat: { type: Number, required: true, min: 1 },          // 1, 2, 3 ... (4 Players: 1-2 = Team 1, 3-4 = Team 2)
    team: { type: Number, enum: [1, 2, null], default: null }, // 4 Players only
    result: { type: String, enum: [...PLAYER_RESULTS, null], default: null }, // set when completed
    score: { type: Number, default: null },                  // not used yet (kept for later scoring)
  },
  { _id: false }
);

const teamSchema = new mongoose.Schema(
  {
    number: { type: Number, enum: [1, 2], required: true },
    name: { type: String, required: true },   // "Team 1"
    seats: { type: [Number], required: true }, // the players' seats
  },
  { _id: false }
);

const matchSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true },
    number: { type: Number, required: true, min: 1 }, // #1, #2 ... within the session

    // Copies from the session's table (history stays readable if the table changes)
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },
    tableNumber: { type: Number, required: true },
    tableName: { type: String, default: "" },

    gameMode: { type: String, enum: ALL_GAME_MODE_KEYS, required: true },
    players: {
      type: [matchPlayerSchema],
      validate: { validator: (list) => list.length >= 2, message: "A match needs at least 2 players" },
    },
    teams: { type: [teamSchema], default: [] }, // 4 Players: Team 1 and Team 2; empty for other modes

    status: { type: String, enum: MATCH_STATUSES, default: "in_progress" },
    // Result (set by "complete", changeable later): the winning seat, or for 4 Players the winning team
    winnerSeat: { type: Number, default: null },
    winningTeam: { type: Number, enum: [1, 2, null], default: null },
    losingTeam: { type: Number, enum: [1, 2, null], default: null },

    startedAt: { type: Date, required: true, default: Date.now }, // server clock
    endedAt: { type: Date, default: null },                       // completed or cancelled at
    resultRecordedAt: { type: Date, default: null },
    resultRecordedBy: { type: actorSchema, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: actorSchema, default: null },
    cancelReason: { type: String, default: "", maxlength: 200 },

    // The match's bill (Phase 11.5): a convenience pointer, set right after the bill is saved. The bill's own
    // `match` reference is the source of truth (Phase 11.8): readers look the bill up by it, and a missing
    // pointer is repaired (matches.service findMatchBill / repairBillPointer).
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", default: null },

    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

// One number per match within a session - the database refuses a duplicate "#2"
matchSchema.index({ session: 1, number: 1 }, { unique: true });
// "In-progress matches of this session"
matchSchema.index({ session: 1, status: 1 });
// Player history and the Players report: "which matches did this player play?" (walk-ins have player: null)
matchSchema.index({ "players.player": 1, startedAt: -1 });
// The Matches / Players reports: matches by period (and game type)
matchSchema.index({ gameMode: 1, startedAt: -1 });

matchSchema.plugin(cleanJson);

const Match = mongoose.model("Match", matchSchema);

module.exports = { Match, MATCH_STATUSES, PLAYER_RESULTS, MATCH_PLAYER_NAME_MAX };
