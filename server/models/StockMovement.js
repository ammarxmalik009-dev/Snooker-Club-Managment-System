// The "stockmovements" collection: EVERY change of a product's stock, with the reason.
// The stock number on the product is only ever changed together with one of these records,
// so the history always explains the current stock.
//
//   initial        stock entered when the product was created          (+)
//   restock        goods received                                       (+)
//   sale           sold on a bill (created when the bill is created)    (-)
//   sale_reversal  a bill was cancelled before payment: stock back      (+)
//   adjustment     correction after counting (admin)                    (+ or -)
//   waste          broken / expired / spilled (admin)                   (-)

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const MOVEMENT_TYPES = ["initial", "restock", "sale", "sale_reversal", "adjustment", "waste"];

const stockMovementSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true }, // copy, so history reads well after renames
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true, validate: { validator: (q) => Number.isInteger(q) && q !== 0, message: "Quantity must be a whole number, not 0" } }, // + in, - out
    balanceAfter: { type: Number, required: true, min: 0 },
    reason: { type: String, trim: true, maxlength: 200, default: "" },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", default: null },
    billNumber: { type: String, default: "" },
    createdBy: { type: actorSchema, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ product: 1, createdAt: -1 });
stockMovementSchema.index({ createdAt: -1 });
stockMovementSchema.index({ bill: 1 }, { partialFilterExpression: { bill: { $type: "objectId" } } });

stockMovementSchema.plugin(cleanJson);

const StockMovement = mongoose.model("StockMovement", stockMovementSchema);

module.exports = { StockMovement, MOVEMENT_TYPES };
