// The "bills" collection: what is owed for one finished session (Create Bill window, and every bill before
// Phase 11.5) or for one completed match of a session (Phase 11.5: one bill per match).
// Everything that decides the amount (rate, tax, players, durations) is COPIED into the
// bill when it is created, so a later change of rates or table names never changes old bills.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const { ALL_GAME_MODE_KEYS, PRICING_TYPES } = require("../config/gameModes");

// Every game mode that can be stored (Phase 11.1: from the central registry, config/gameModes.js).
// Which modes NEW bills may use is checked by the validators (enabled modes only).
const GAME_MODES = ALL_GAME_MODE_KEYS;
const PAYER_RULES = ["loser", "winner", "split"];
const CAFE_PAYER_RULES = ["loser", "consumer", "split"]; // Phase 10
const BILL_STATUSES = ["unpaid", "partially_paid", "paid", "cancelled"];
const PLAYER_RESULTS = ["winner", "loser"];

const money = { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: "Amounts must be whole paisa" } };

const lineItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["game", "cafe"], required: true }, // "cafe" = drinks/snacks added to the bill
    description: { type: String, required: true, trim: true, maxlength: 60 },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: money,
    amount: money,
    // Phase 10 (café lines only; older bills simply don't have these):
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: undefined }, // null/absent = typed-in item
    categoryName: { type: String, default: undefined },   // copy of the category name at billing time
    consumer: { type: String, default: undefined },       // which player had it ("consumer pays")
    consumerPlayer: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: undefined }, // Phase 11.5: that player, if registered
    cafeOrder: { type: mongoose.Schema.Types.ObjectId, ref: "CafeOrder", default: undefined }, // came from the session tab
  },
  { _id: false }
);

const playerSchema = new mongoose.Schema(
  {
    // 40 characters on bills made in the Create Bill window; a registered player's name (match bills) can be 60
    name: { type: String, required: true, trim: true, maxlength: 60 },
    result: { type: String, enum: [...PLAYER_RESULTS, null], default: null },
    // Phase 11.5 (match bills only): the registered player (absent = walk-in) and the 4 Players team
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: undefined },
    team: { type: Number, default: undefined },
    shareAmount: money, // how much this player has to pay
    paidAmount: { ...money, default: 0 }, // how much this player has paid so far
    // Phase 10: with a separate café payer rule, shareAmount = gameShare + cafeShare
    gameShare: { type: Number, default: undefined },
    cafeShare: { type: Number, default: undefined },
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    billNumber: { type: String, required: true }, // e.g. B-20261005-0007

    // The session this bill is for, plus copies of its details
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true },
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table" },
    tableNumber: { type: Number, required: true },
    tableName: { type: String, default: "" },
    sessionStartedAt: { type: Date, required: true },
    sessionEndedAt: { type: Date, required: true },
    durationSeconds: { type: Number, required: true, min: 0 },
    billedMinutes: { type: Number, required: true, min: 0 }, // time rule result (15 min minimum, 5 min steps)

    // What was played, at which price (rate snapshot)
    gameMode: { type: String, enum: GAME_MODES, required: true },
    quantity: { type: Number, required: true, min: 1, max: 100 }, // games/frames played
    unitPrice: money, // the rate at billing time (per minute when pricingType is "per_minute")
    // Phase 11.3: how the game line was priced, copied from the registry at billing time.
    // Absent on older bills = quantity × unitPrice (Century per game, Frame per frame).
    pricingType: { type: String, enum: PRICING_TYPES, default: undefined },

    // Phase 11.5: the match this bill is for. ABSENT on bills made for a whole session (the Create
    // Bill window, and every bill made before Phase 11.5) - those are never given a fake match.
    match: { type: mongoose.Schema.Types.ObjectId, ref: "Match", default: undefined },
    matchNumber: { type: Number, default: undefined },  // copy: "Match #2"
    winningTeam: { type: Number, default: undefined },  // copies of a 4 Players result
    losingTeam: { type: Number, default: undefined },

    lineItems: { type: [lineItemSchema], required: true },

    subtotal: money,
    taxEnabled: { type: Boolean, default: false },
    taxRateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    taxAmount: { ...money, default: 0 },
    total: money,

    // Who pays: the loser, the winner, or everyone splits
    payerRule: { type: String, enum: PAYER_RULES, required: true },
    // Phase 10: who pays the CAFÉ part. null = the café follows payerRule (how every older bill works)
    cafePayerRule: { type: String, enum: [...CAFE_PAYER_RULES, null], default: null },
    players: {
      type: [playerSchema],
      // The Create Bill window allows 2-4 players (checked by its validator); a match bill has the match's players
      validate: { validator: (list) => list.length >= 2 && list.length <= 20, message: "A bill needs 2 to 20 players" },
    },

    amountPaid: { ...money, default: 0 },
    status: { type: String, enum: BILL_STATUSES, default: "unpaid" },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "", maxlength: 200 },

    // Audit (Phase 8): who created / cancelled the bill (null on bills made before logins existed)
    createdBy: { type: actorSchema, default: null },
    cancelledBy: { type: actorSchema, default: null },
  },
  { timestamps: true } // createdAt = the bill's date
);

// What is still owed
billSchema.virtual("balanceDue").get(function balanceDue() {
  return this.status === "cancelled" ? 0 : this.total - this.amountPaid;
});

billSchema.index({ billNumber: 1 }, { unique: true });
// Enforced by the database itself (Phase 11.5 - replaces the old unique { session } index):
//  - a bill for a whole session (no match) : at most ONE per session   (session, match: null)
//  - a bill for a match                    : at most ONE per match     (session, match)
// A session with matches can therefore have many bills - one per match.
billSchema.index({ session: 1, match: 1 }, { unique: true, name: "one_bill_per_session_or_match" });
// Century is charged by the SESSION's time: two Century match bills in one session would charge
// that time twice, so the database allows only one per session.
billSchema.index(
  { session: 1 },
  { unique: true, name: "one_century_time_bill_per_session", partialFilterExpression: { match: { $type: "objectId" }, pricingType: "per_minute" } }
);
billSchema.index({ match: 1 }, { name: "bills_by_match", partialFilterExpression: { match: { $type: "objectId" } } });
billSchema.index({ createdAt: -1 });
billSchema.index({ status: 1, createdAt: -1 });
// Phase 11.6: a registered player's bills (player history and outstanding). Only bills that carry a
// player reference (match bills) are in it; older bills and walk-ins are simply not indexed.
billSchema.index(
  { "players.player": 1, createdAt: -1 },
  { name: "bills_by_registered_player", partialFilterExpression: { "players.player": { $type: "objectId" } } }
);

// Same clean JSON as the other models ("id" instead of "_id", no "__v"),
// plus the calculated "balanceDue" field
billSchema.plugin(cleanJson, { virtuals: true });

const Bill = mongoose.model("Bill", billSchema);

module.exports = { Bill, GAME_MODES, PAYER_RULES, CAFE_PAYER_RULES, BILL_STATUSES, PLAYER_RESULTS };
