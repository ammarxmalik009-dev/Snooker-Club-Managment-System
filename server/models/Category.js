// The "categories" collection: groups of café products (Drinks, Snacks, Hot drinks, ...).
// Names are trimmed and unique WITHOUT looking at capital letters: "Drinks" = "drinks".

const mongoose = require("mongoose");
const cleanJson = require("./plugins/cleanJson");
const { actorSchema } = require("./schemas/actor");

const CATEGORY_NAME = { min: 2, max: 100 };

// The same text in one form for comparing: trimmed, single spaces, lower case
function nameKeyOf(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      minlength: [CATEGORY_NAME.min, `Category name must be at least ${CATEGORY_NAME.min} characters`],
      maxlength: [CATEGORY_NAME.max, `Category name must be at most ${CATEGORY_NAME.max} characters`],
    },
    nameKey: { type: String, required: true }, // filled from name, used for the "already exists" rule
    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
  },
  { timestamps: true }
);

categorySchema.pre("validate", function fillNameKey() {
  this.nameKey = nameKeyOf(this.name);
});

// Two categories can never have the same name (any capitals) - the database itself refuses it
categorySchema.index({ nameKey: 1 }, { unique: true });

categorySchema.plugin(cleanJson);
categorySchema.set("toJSON", {
  ...categorySchema.get("toJSON"),
  transform(document, json) {
    const { _id, id, nameKey, ...rest } = json;
    return { id: String(_id), ...rest };
  },
});

const Category = mongoose.model("Category", categorySchema);

module.exports = { Category, CATEGORY_NAME, nameKeyOf };
