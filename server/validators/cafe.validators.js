// Input rules for the café endpoints (Phase 10): categories, products, stock and session tabs.
// Money arrives as whole paisa (the pages convert "80.50" -> 8050), like the rest of the API.

const { body, param, query } = require("express-validator");
const { CATEGORY_NAME } = require("../models/Category");
const { PRODUCT_STATUSES, PRODUCT_NAME, MAX_STOCK } = require("../models/Product");
const { MOVEMENT_TYPES } = require("../models/StockMovement");
const { MAX_PRICE } = require("../models/Setting");

const MAX_PRICE_TEXT = "Rs 100,000";

function isCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

// Collapses inner spaces too: "  Soft   drinks " -> "Soft drinks"
const tidy = (value) => String(value).trim().replace(/\s+/g, " ");

const idRules = [param("id").isMongoId().withMessage("Invalid id")];
const atLeastOne = (fields) =>
  body().custom((data) => Boolean(data) && fields.some((f) => f in data)).withMessage(`Send at least one field to change: ${fields.join(", ")}`);

// ---------- Categories ----------

const categoryName = () =>
  body("name").exists({ values: "falsy" }).withMessage("Category name is required").bail()
    .isString().withMessage("Category name must be text").bail()
    .customSanitizer(tidy)
    .isLength({ min: CATEGORY_NAME.min }).withMessage(`Category name must be at least ${CATEGORY_NAME.min} characters`).bail()
    .isLength({ max: CATEGORY_NAME.max }).withMessage(`Category name must be at most ${CATEGORY_NAME.max} characters`);

const categoryListRules = [
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
];
const categoryCreateRules = [categoryName()];
const categoryUpdateRules = [...idRules, categoryName()];

// ---------- Products ----------

function productRules({ required }) {
  // "falsy": an empty text counts as missing; "null": 0 is a real value (a free item costs Rs 0)
  const field = (name, label, values = "falsy") => {
    const chain = body(name);
    return required ? chain.exists({ values }).withMessage(`${label} is required`).bail() : chain.optional();
  };
  return [
    field("name", "Product name").isString().withMessage("Product name must be text").bail()
      .customSanitizer(tidy)
      .isLength({ min: PRODUCT_NAME.min }).withMessage(`Product name must be at least ${PRODUCT_NAME.min} characters`).bail()
      .isLength({ max: PRODUCT_NAME.max }).withMessage(`Product name must be at most ${PRODUCT_NAME.max} characters`),
    field("categoryId", "Category").isMongoId().withMessage("Choose a category"),
    field("price", "Price", "null").isInt({ min: 0, max: MAX_PRICE }).withMessage(`Price must be between Rs 0 and ${MAX_PRICE_TEXT}`).bail().toInt(),
    body("trackStock").optional().isBoolean({ strict: true }).withMessage("Track stock must be true or false").bail().toBoolean(),
    body("lowStockLimit").optional().isInt({ min: 0, max: MAX_STOCK }).withMessage(`Low stock limit must be a whole number from 0 to ${MAX_STOCK.toLocaleString("en-US")}`).bail().toInt(),
    body("status").optional().isIn(PRODUCT_STATUSES).withMessage("Status must be active or inactive"),
  ];
}

const productCreateRules = [
  ...productRules({ required: true }),
  body("stockQuantity").optional().isInt({ min: 0, max: MAX_STOCK }).withMessage(`Starting stock must be a whole number from 0 to ${MAX_STOCK.toLocaleString("en-US")}`).bail().toInt(),
];

const productUpdateRules = [
  ...idRules,
  // (stockQuantity counts as "sent" here, so the only message is the clear one below)
  atLeastOne(["name", "categoryId", "price", "trackStock", "lowStockLimit", "status", "stockQuantity"]),
  // Stock changes only through Restock / Adjust, so every change has a history line
  body("stockQuantity").not().exists().withMessage("Stock can't be edited here. Use Restock or Adjust stock, so the change is recorded."),
  ...productRules({ required: false }),
];

const productListRules = [
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("categoryId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid category id"),
  query("status").optional({ values: "falsy" }).isIn([...PRODUCT_STATUSES, "all"]).withMessage("Status must be active, inactive or all"),
  // Kept as the text "true"/"false" (a real false would be dropped as "empty"); the service converts them
  query("lowStock").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("Low stock must be true or false"),
  query("trackStock").optional({ values: "falsy" }).isIn(["true", "false"]).withMessage("Track stock must be true or false"),
];

// ---------- Stock ----------

const reasonRule = (required) => {
  const chain = body("reason");
  return (required ? chain.exists({ values: "falsy" }).withMessage("Give a reason (e.g. counted 23, 2 bottles broken)").bail() : chain.optional({ values: "null" }))
    .isString().bail().trim().isLength({ max: 200 }).withMessage("Reason must be at most 200 characters");
};

const restockRules = [
  ...idRules,
  body("quantity").exists({ values: "null" }).withMessage("Enter how many arrived").bail()
    .isInt({ min: 1, max: MAX_STOCK }).withMessage("Quantity must be a whole number of 1 or more").bail().toInt(),
  reasonRule(false),
];

const adjustRules = [
  ...idRules,
  body("type").exists({ values: "falsy" }).withMessage("Choose adjustment or waste").bail()
    .isIn(["adjustment", "waste"]).withMessage("Type must be adjustment or waste"),
  body("quantity").exists({ values: "null" }).withMessage("Enter the quantity").bail()
    .isInt({ min: -MAX_STOCK, max: MAX_STOCK }).withMessage("Quantity must be a whole number").bail().toInt()
    .custom((quantity, { req }) => {
      if (quantity === 0) throw new Error("Quantity can't be 0");
      if (req.body.type === "waste" && quantity < 0) throw new Error("For waste, enter how many were thrown away (a positive number)");
      return true;
    }),
  reasonRule(true),
];

const movementListRules = [
  query("productId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid product id"),
  query("type").optional({ values: "falsy" }).isIn(MOVEMENT_TYPES).withMessage("Type must be one of: " + MOVEMENT_TYPES.join(", ")),
  query("from").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("From date must be a date like 2026-10-05"),
  query("to").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("To date must be a date like 2026-10-05"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

// ---------- Session tab ----------

const sessionIdRule = param("sessionId").isMongoId().withMessage("Invalid session id");
const itemIdRule = param("itemId").isMongoId().withMessage("Invalid café item id");
const consumerRule = body("consumer").optional({ values: "null" }).isString().withMessage("Consumer must be a name").bail()
  .trim().isLength({ max: 60 }).withMessage("Consumer name is too long (max 60 characters)"); // 60 = a registered player's name
const quantityRule = (required) => {
  const chain = body("quantity");
  return (required ? chain.exists({ values: "null" }).withMessage("Enter a quantity").bail() : chain.optional())
    .isInt({ min: 1, max: 99 }).withMessage("Quantity must be 1 to 99").bail().toInt();
};

const tabItemTyped = (value, { req }) => !req.body.productId;
const tabListRules = [sessionIdRule];
const tabAddRules = [
  sessionIdRule,
  body().custom((data) => Boolean(data && (data.productId || data.description))).withMessage("Choose a product or type an item name"),
  body("productId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid product id"),
  body("description").if(tabItemTyped).isString().withMessage("Item name must be text").bail()
    .trim().isLength({ min: 1, max: 60 }).withMessage("Item name is required (max 60 characters)"),
  body("unitPrice").if(tabItemTyped).exists({ values: "null" }).withMessage("Enter the price").bail()
    .isInt({ min: 0, max: MAX_PRICE }).withMessage(`Price must be between Rs 0 and ${MAX_PRICE_TEXT}`).bail().toInt(),
  quantityRule(true),
  consumerRule,
];
const tabUpdateRules = [sessionIdRule, itemIdRule, atLeastOne(["quantity", "consumer"]), quantityRule(false), consumerRule];
const tabRemoveRules = [sessionIdRule, itemIdRule];

module.exports = {
  idRules,
  categoryListRules, categoryCreateRules, categoryUpdateRules,
  productListRules, productCreateRules, productUpdateRules,
  restockRules, adjustRules, movementListRules,
  tabListRules, tabAddRules, tabUpdateRules, tabRemoveRules,
};
