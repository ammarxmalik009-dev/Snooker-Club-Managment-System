// Input rules for the match endpoints (Phase 11.4). The shape is checked here; the game-mode
// rules (how many players, teams of two, who can win) are checked by the service, from the registry.

const { body, param } = require("express-validator");
const { MATCH_GAME_MODE_KEYS, gameModeLabel, joinOr } = require("../config/gameModes");

const MAX_MATCH_PLAYERS = 20; // a safety limit for the request size - Century/Frame have no game limit below it
const WALK_IN_NAME_MAX = 40;  // the same limit as a player's name on a bill

const tidy = (value) => String(value).trim().replace(/\s+/g, " ");

const sessionRules = [param("sessionId").isMongoId().withMessage("Invalid session id")];
const idRules = [param("id").isMongoId().withMessage("Invalid match id")];

const gameModeRule = (required) => {
  const chain = body("gameMode");
  if (required) chain.exists({ values: "falsy" }).withMessage(`Choose ${joinOr(MATCH_GAME_MODE_KEYS.map(gameModeLabel))}`).bail();
  else chain.optional();
  return chain.isIn(MATCH_GAME_MODE_KEYS).withMessage(`Game type must be ${joinOr(MATCH_GAME_MODE_KEYS)}`);
};

// players: [{ playerId: "<registered player>" } | { playerId: null, name: "Guest" }, team?: 1 | 2]
const playersRules = [
  body("players")
    .isArray({ min: 1, max: MAX_MATCH_PLAYERS }).withMessage(`Add the players (at most ${MAX_MATCH_PLAYERS})`),
  body("players.*")
    .custom((p) => p !== null && typeof p === "object" && !Array.isArray(p)).withMessage("Each player must be a registered player or a walk-in name")
    .bail()
    .custom((p) => Boolean(p.playerId) || (typeof p.name === "string" && tidy(p.name).length >= 1 && tidy(p.name).length <= WALK_IN_NAME_MAX))
    .withMessage(`Each walk-in player needs a name (max ${WALK_IN_NAME_MAX} characters)`),
  body("players.*.playerId").optional({ values: "null" }).isMongoId().withMessage("Choose the registered player from the list"),
  body("players.*.name").optional({ values: "null" }).isString().withMessage("Player names must be text").bail().customSanitizer(tidy),
  body("players.*.team").optional({ values: "null" }).isInt({ min: 1, max: 2 }).withMessage("Team must be 1 or 2").bail().toInt(),
];

const createRules = [...sessionRules, gameModeRule(true), ...playersRules];

const updateRules = [
  ...idRules,
  body().custom((data) => Boolean(data) && "players" in data).withMessage("Send the players (and, if it changes, the game type)"),
  gameModeRule(false),
  ...playersRules,
];

// { winnerSeat: 2 } or, for 4 Players, { winningTeam: 1 }
const resultRules = [
  ...idRules,
  body().custom((data) => Boolean(data) && (data.winnerSeat !== undefined || data.winningTeam !== undefined))
    .withMessage("Choose the winner (or, for 4 Players, the winning team)"),
  body("winnerSeat").optional({ values: "null" }).isInt({ min: 1, max: MAX_MATCH_PLAYERS }).withMessage("Choose the winner from the match's players").bail().toInt(),
  body("winningTeam").optional({ values: "null" }).isInt({ min: 1, max: 2 }).withMessage("Winning team must be 1 or 2").bail().toInt(),
];

const cancelRules = [
  ...idRules,
  body("reason").optional({ values: "null" }).isString().withMessage("Reason must be text").bail()
    .trim().isLength({ max: 200 }).withMessage("Reason must be at most 200 characters"),
];

module.exports = { sessionRules, idRules, createRules, updateRules, resultRules, cancelRules, MAX_MATCH_PLAYERS, WALK_IN_NAME_MAX };
