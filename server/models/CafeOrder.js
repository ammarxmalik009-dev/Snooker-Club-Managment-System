// The "cafeorders" collection: café items put on a session's TAB while the players are
// playing (one document per item line). When the session is billed, every open item
// becomes a café line on the bill.
//
//   open     on the tab, not billed yet (can still be changed or removed)
//   billed   included in a bill (bill + billedAt are set)
//   removed  taken off the tab before billing (kept for the history)
//
// The name and price are COPIED when the item is added, so a later price change
// doesn't change what was ordered. Stock is taken off when the bill is created.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");
const { MAX_PRICE } = require("./Setting");

const CAFE_ORDER_STATUSES = ["open", "billed", "removed"];

const cafeOrderSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true },
    tableNumber: { type: Number, required: true },

    // A product from the list, or null for a typed-in one-off item
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    description: { type: String, required: true, trim: true, maxlength: 60 },
    categoryName: { type: String, default: "" },
    unitPrice: { type: Number, required: true, min: 0, max: MAX_PRICE, validate: { validator: Number.isInteger, message: "Price must be whole paisa" } },
    quantity: { type: Number, required: true, min: 1, max: 99, validate: { validator: Number.isInteger, message: "Quantity must be a whole number" } },
    // who had it (optional; used by "consumer pays"). 60 = a registered player's longest name (Phase 11.6)
    consumer: { type: String, trim: true, maxlength: 60, default: "" },

    status: { type: String, enum: CAFE_ORDER_STATUSES, default: "open" },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", default: null },
    billedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },

    addedBy: { type: actorSchema, default: null },
    removedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

cafeOrderSchema.index({ session: 1, status: 1, createdAt: 1 });
cafeOrderSchema.index({ product: 1, status: 1 }); // "how many are on open tabs?" + "was it ever ordered?"

cafeOrderSchema.plugin(cleanJson);

const CafeOrder = mongoose.model("CafeOrder", cafeOrderSchema);

module.exports = { CafeOrder, CAFE_ORDER_STATUSES };
