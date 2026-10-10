// The "products" collection: things the café sells (water, cola, tea, chips, ...).
//
// Money: the price is whole paisa (Rs 80.00 = 8000), like every amount in this app.
// Stock:
//   - trackStock true  -> stockQuantity is counted, can never go below 0, and only changes
//                         through stock movements (restock, sale, adjustment, waste) - see StockMovement.
//   - trackStock false -> made to order (tea, coffee): no count, never "out of stock".
// A product that was ever sold is set "inactive" instead of being deleted, so history stays complete.

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");
const { nameKeyOf } = require("./Category");
const { MAX_PRICE } = require("./Setting");

const PRODUCT_STATUSES = ["active", "inactive"];
const PRODUCT_NAME = { min: 2, max: 100 };
const MAX_STOCK = 1_000_000; // sanity limit (same as Malik's Products module)
const DEFAULT_LOW_STOCK_LIMIT = 5;

const wholeNumber = (label) => ({ validator: Number.isInteger, message: `${label} must be a whole number` });

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      minlength: [PRODUCT_NAME.min, `Product name must be at least ${PRODUCT_NAME.min} characters`],
      maxlength: [PRODUCT_NAME.max, `Product name must be at most ${PRODUCT_NAME.max} characters`],
    },
    nameKey: { type: String, required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: [true, "Category is required"] },

    price: { type: Number, required: true, min: 0, max: MAX_PRICE, validate: wholeNumber("Price") }, // paisa

    trackStock: { type: Boolean, default: true },
    stockQuantity: { type: Number, default: 0, min: [0, "Stock can never be below 0"], max: MAX_STOCK, validate: wholeNumber("Stock") },
    lowStockLimit: { type: Number, default: DEFAULT_LOW_STOCK_LIMIT, min: 0, max: MAX_STOCK, validate: wholeNumber("Low stock limit") },

    status: { type: String, enum: { values: PRODUCT_STATUSES, message: "Status must be active or inactive" }, default: "active" },

    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

productSchema.pre("validate", function fillNameKey() {
  this.nameKey = nameKeyOf(this.name);
});

// Low stock: counted products at or below their limit
productSchema.virtual("isLowStock").get(function isLowStock() {
  return this.trackStock && this.stockQuantity <= this.lowStockLimit;
});

// The same name can't appear twice in ONE category ("Cola" in Drinks once; "Cola" in Snacks is a different product)
productSchema.index({ category: 1, nameKey: 1 }, { unique: true, name: "unique_name_per_category" });
productSchema.index({ status: 1, nameKey: 1 });

productSchema.plugin(cleanJson, { virtuals: true });
productSchema.set("toJSON", {
  ...productSchema.get("toJSON"),
  transform(document, json) {
    const { _id, id, nameKey, ...rest } = json;
    return { id: String(_id), ...rest };
  },
});

const Product = mongoose.model("Product", productSchema);

module.exports = { Product, PRODUCT_STATUSES, PRODUCT_NAME, MAX_STOCK, DEFAULT_LOW_STOCK_LIMIT };
