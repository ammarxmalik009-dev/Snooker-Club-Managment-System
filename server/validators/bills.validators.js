// Input rules for the /api/bills endpoints.

const { body, param, query } = require("express-validator");
const { PAYER_RULES, CAFE_PAYER_RULES, BILL_STATUSES, PLAYER_RESULTS } = require("../models/Bill");
const { ENABLED_GAME_MODE_KEYS, gameModeLabel, joinOr } = require("../config/gameModes");
const { PAYMENT_METHODS } = require("../models/Payment");
const { MAX_PRICE } = require("../models/Setting");

const MAX_CAFE_ITEMS = 20;

function isCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

const idRules = [param("id").isMongoId().withMessage("Invalid bill id")];

// ---------- Create / preview ----------

// Checks that the players fit the chosen "who pays" rule
function checkPayerRule(players, { req }) {
  const rule = req.body.payerRule;
  const names = players.map((player) => String(player.name || "").trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Each player needs a different name");

  const count = (result) => players.filter((player) => player.result === result).length;
  if (rule === "loser" && count("loser") !== 1) throw new Error("Choose the one player who lost (the loser pays)");
  if (rule === "winner" && count("winner") !== 1) throw new Error("Choose the one player who won (the winner pays)");
  return true;
}

const billInputRules = [
  body("sessionId").exists({ values: "falsy" }).withMessage("Choose the session to bill").bail()
    .isMongoId().withMessage("Invalid session id"),
  // Only modes that are enabled in the registry can be billed (old bills keep any stored mode)
  body("gameMode").exists({ values: "falsy" }).withMessage(`Choose ${joinOr(ENABLED_GAME_MODE_KEYS.map(gameModeLabel))}`).bail()
    .isIn(ENABLED_GAME_MODE_KEYS).withMessage(`Game type must be ${joinOr(ENABLED_GAME_MODE_KEYS)}`),
  body("quantity").exists({ values: "null" }).withMessage("Enter how many games/frames were played").bail()
    .isInt({ min: 1, max: 100 }).withMessage("Number of games/frames must be from 1 to 100").bail().toInt(),
  body("payerRule").exists({ values: "falsy" }).withMessage("Choose who pays").bail()
    .isIn(PAYER_RULES).withMessage("Who pays must be loser, winner or split"),

  body("players").isArray({ min: 2, max: 4 }).withMessage("Add 2 to 4 players").bail().custom(checkPayerRule),
  body("players.*.name").isString().withMessage("Player name must be text").bail()
    .trim().isLength({ min: 1, max: 40 }).withMessage("Each player needs a name (max 40 characters)"),
  body("players.*.result").optional({ values: "null" }).isIn(PLAYER_RESULTS).withMessage("Result must be winner or loser"),
];

// The café part, the same for bills made in the Create Bill window and match bills
const cafeRules = [
  body("cafeItems").optional().isArray({ max: MAX_CAFE_ITEMS }).withMessage(`At most ${MAX_CAFE_ITEMS} café items`),
  // Phase 10: a café item is EITHER a product from the list ({ productId, quantity })
  // OR a typed-in one-off item ({ description, quantity, unitPrice }) - exactly as before
  body("cafeItems.*.productId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid product id"),
  body("cafeItems.*.description").if(isTypedInItem).isString().withMessage("Café item name must be text").bail()
    .trim().isLength({ min: 1, max: 60 }).withMessage("Each café item needs a name (max 60 characters)"),
  body("cafeItems.*.quantity").isInt({ min: 1, max: 99 }).withMessage("Café item quantity must be 1 to 99").bail().toInt(),
  body("cafeItems.*.unitPrice").if(isTypedInItem).isInt({ min: 0, max: MAX_PRICE }).withMessage("Café item price must be between Rs 0 and Rs 100,000").bail().toInt(),
  body("cafeItems.*.consumer").optional({ values: "null" }).isString().withMessage("Consumer must be a player's name").bail()
    .trim().isLength({ max: 60 }).withMessage("Consumer name is too long"),
  // Who pays the café part (left out = the café follows "who pays", exactly like before Phase 10)
  body("cafePayerRule").optional({ values: "falsy" }).isIn(CAFE_PAYER_RULES)
    .withMessage("Who pays for the café must be loser, consumer or split"),
  // Who had each item already on the session's tab: [{ id, consumer }]
  body("tabItems").optional().isArray({ max: 200 }).withMessage("Tab items must be a list"),
  body("tabItems.*.id").isMongoId().withMessage("Invalid café item id"),
  body("tabItems.*.consumer").optional({ values: "null" }).isString().withMessage("Consumer must be a player's name").bail()
    .trim().isLength({ max: 60 }).withMessage("Consumer name is too long"),
];
billInputRules.push(...cafeRules);

// ---------- Match bills (Phase 11.5): POST /api/matches/:id/bill (+ /preview) ----------
// Only who pays and the café choices are sent. The game type, the number of games, the players and
// the result come from the MATCH - sending them is refused, so a Frame can never be billed as Century.
const FROM_THE_MATCH = ["gameMode", "quantity", "players", "sessionId", "unitPrice", "matchId"];
const matchBillRules = [
  param("id").isMongoId().withMessage("Invalid match id"),
  body().custom((data) => !data || FROM_THE_MATCH.every((field) => !(field in data)))
    .withMessage("The game type, players and result come from the match and can't be changed on its bill"),
  body("payerRule").exists({ values: "falsy" }).withMessage("Choose who pays").bail()
    .isIn(PAYER_RULES).withMessage("Who pays must be loser, winner or split"),
  body("includeCafeTab").optional().isBoolean({ strict: true }).withMessage("Put the café tab on this bill: true or false").bail().toBoolean(),
  ...cafeRules,
];
const matchIdRules = [param("id").isMongoId().withMessage("Invalid match id")];

// true for a typed-in café item (no productId) - its name and price must then be given
function isTypedInItem(value, { req, path }) {
  const index = Number((/\[(\d+)\]/.exec(path) || [])[1]);
  const item = Array.isArray(req.body.cafeItems) ? req.body.cafeItems[index] : null;
  return !(item && item.productId);
}

// ---------- List ----------

const listRules = [
  query("status").optional({ values: "falsy" }).isIn([...BILL_STATUSES, "open"])
    .withMessage("Status filter must be one of: " + [...BILL_STATUSES, "open"].join(", ")),
  query("from").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("From date must be a date like 2026-10-05"),
  query("to").optional({ values: "falsy" }).custom(isCalendarDate).withMessage("To date must be a date like 2026-10-05")
    .custom((to, { req }) => {
      if (req.query.from && isCalendarDate(req.query.from) && to < req.query.from) throw new Error("To date cannot be before the From date");
      return true;
    }),
  query("search").optional({ values: "falsy" }).isString().bail().trim().isLength({ max: 50 }).withMessage("Search text must be at most 50 characters"),
  query("page").optional({ values: "falsy" }).isInt({ min: 1, max: 100000 }).withMessage("Page must be 1 or more").toInt(),
  query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 100 }).withMessage("Limit must be from 1 to 100").toInt(),
];

// ---------- Cancel & pay ----------

const cancelRules = [
  ...idRules,
  body("reason").optional({ values: "null" }).isString().bail().trim().isLength({ max: 200 }).withMessage("Reason must be at most 200 characters"),
];

const paymentRules = [
  ...idRules,
  body("amount").exists({ values: "null" }).withMessage("Enter the amount received").bail()
    .isInt({ min: 1, max: MAX_PRICE * 100 }).withMessage("Amount must be more than Rs 0").bail().toInt(),
  body("method").exists({ values: "falsy" }).withMessage("Choose how it was paid").bail()
    .isIn(PAYMENT_METHODS).withMessage("Payment method must be one of: " + PAYMENT_METHODS.join(", ")),
  body("payerName").exists({ values: "falsy" }).withMessage("Choose which player paid").bail()
    .isString().trim().isLength({ min: 1, max: 60 }).withMessage("Player name is too long"),
  body("note").optional({ values: "null" }).isString().bail().trim().isLength({ max: 120 }).withMessage("Note must be at most 120 characters"),
];

module.exports = { idRules, billInputRules, listRules, cancelRules, paymentRules, matchBillRules, matchIdRules };
