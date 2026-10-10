// The "customers" collection: people who book tables.
// Phone is optional and NOT unique (family members may share one number).

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [60, "Name must be at most 60 characters"],
    },
    phone: { type: String, trim: true, maxlength: 20, default: "" }, // as typed, e.g. "0300-1234567"
    phoneDigits: { type: String, default: "" }, // digits only, e.g. "03001234567" - used for searching
    notes: { type: String, trim: true, maxlength: 200, default: "" },

    // false = archived: hidden from lists, but kept because old bookings point to it
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Keep phoneDigits in step with phone
customerSchema.pre("validate", function fillPhoneDigits() {
  this.phoneDigits = (this.phone || "").replace(/\D/g, "");
});

customerSchema.index({ name: 1 });
customerSchema.index({ phoneDigits: 1 });
customerSchema.index({ isActive: 1, name: 1 });
customerSchema.index({ createdAt: 1 }); // Phase 9: "new customers in this period"

customerSchema.plugin(cleanJson);

const Customer = mongoose.model("Customer", customerSchema);

module.exports = { Customer };
