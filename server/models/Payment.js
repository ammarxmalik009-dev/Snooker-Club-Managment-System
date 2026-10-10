// The "payments" collection: each amount of money actually received for a bill.
// A bill can have several payments (partial payments, or each player paying their share).

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const PAYMENT_METHODS = ["cash", "card", "jazzcash", "easypaisa", "bank_transfer", "other"];

const paymentSchema = new mongoose.Schema(
  {
    bill: { type: mongoose.Schema.Types.ObjectId, ref: "Bill", required: true },
    amount: {
      type: Number,
      required: true,
      min: [1, "Payment must be more than Rs 0"],
      validate: { validator: Number.isInteger, message: "Amount must be whole paisa" },
    },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    payerName: { type: String, required: true, trim: true, maxlength: 60 }, // which player paid (a registered name can be 60)
    note: { type: String, trim: true, maxlength: 120, default: "" },
    paidAt: { type: Date, required: true, default: Date.now }, // server clock
    receivedBy: { type: actorSchema, default: null }, // the logged-in user who recorded it (Phase 8)
  },
  { timestamps: true }
);

paymentSchema.index({ bill: 1, paidAt: 1 });
paymentSchema.index({ paidAt: -1 });

paymentSchema.plugin(cleanJson);

const Payment = mongoose.model("Payment", paymentSchema);

module.exports = { Payment, PAYMENT_METHODS };
