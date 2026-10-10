// THE ONE PLACE that describes the game modes (Phase 11.1).
// Every other file (models, validators, billing, reports, pages via GET /api/game-modes)
// asks this registry instead of writing "century" / "frame" itself.
//
//   key            stored on bills/matches - NEVER rename a key (old bills keep it forever)
//   label          what people see
//   minPlayers     fewest players for the mode
//   maxPlayers     most players, null = no limit
//   pricingType    how the game line is priced (Phase 11.3):
//                    "per_minute" billed minutes × rate  (Century - the same time rule as every bill)
//                    "per_frame"  quantity × rate        (Frame)
//                    "fixed"      quantity × rate        (Snooker Point, 4 Players - one rate per game)
//                  ("per_game" = quantity × rate: how Century was priced before Phase 11.3; old
//                   bills without a stored pricingType were priced this way)
//   defaultRate    the rate (paisa) used until an admin sets one in Settings
//   rateUnit       what one rate pays for: { one, many } ("minute", "frame", "game")
//   legacyRateSetting  an older Settings field that still counts as this mode's rate when the
//                  new rate was never set (Frame: framePrice). Century has none: its old
//                  per-GAME price means something else than the new per-MINUTE rate.
//   quantityLabel  words for the counted unit: { one, many }
//   lineText       words on the bill line for quantity pricing: { one, many }
//   resultType     "winner_loser" (players) or "teams" (two teams)
//   teams          for team modes: { key, number, seats } - Team 1 = seats 1-2, Team 2 = seats 3-4
//   enabled        true = can be used in the Create Bill window (Century, Frame). The other modes
//                  get their bills from matches in Phase 11.5.
//   matchEnabled   true = matches of this mode can be played and recorded (Phase 11.4)
//
// The rates themselves live in Settings.gameRates (admin), resolved by rateFromSettings().

const GAME_MODES = Object.freeze([
  Object.freeze({
    key: "century",
    label: "Century",
    minPlayers: 2,
    maxPlayers: null,
    pricingType: "per_minute",
    defaultRate: 1000, // Rs 10 per minute
    rateUnit: Object.freeze({ one: "minute", many: "minutes" }),
    legacyRateSetting: null,
    quantityLabel: Object.freeze({ one: "game", many: "games" }),
    lineText: Object.freeze({ one: "Century game", many: "Century games" }),
    resultType: "winner_loser",
    teams: null,
    enabled: true,
    matchEnabled: true,
  }),
  Object.freeze({
    key: "frame",
    label: "Frame",
    minPlayers: 2,
    maxPlayers: null,
    pricingType: "per_frame",
    defaultRate: 25000, // Rs 250 per frame
    rateUnit: Object.freeze({ one: "frame", many: "frames" }),
    legacyRateSetting: "framePrice",
    quantityLabel: Object.freeze({ one: "frame", many: "frames" }),
    lineText: Object.freeze({ one: "Frame", many: "Frames" }),
    resultType: "winner_loser",
    teams: null,
    enabled: true,
    matchEnabled: true, // one frame = one match
  }),
  Object.freeze({
    key: "snooker_point",
    label: "Snooker Point",
    minPlayers: 3,
    maxPlayers: 3,
    pricingType: "fixed",
    defaultRate: 35000, // Rs 350 per game
    rateUnit: Object.freeze({ one: "game", many: "games" }),
    legacyRateSetting: null,
    quantityLabel: Object.freeze({ one: "game", many: "games" }),
    lineText: Object.freeze({ one: "Snooker Point game", many: "Snooker Point games" }),
    resultType: "winner_loser",
    teams: null,
    enabled: false, // not in the Create Bill window: billed from its matches in Phase 11.5
    matchEnabled: true, // simple result only (winner), no point-by-point scoring
  }),
  Object.freeze({
    key: "four_player",
    label: "4 Players",
    minPlayers: 4,
    maxPlayers: 4,
    pricingType: "fixed",
    defaultRate: 50000, // Rs 500 per game
    rateUnit: Object.freeze({ one: "game", many: "games" }),
    legacyRateSetting: null,
    quantityLabel: Object.freeze({ one: "game", many: "games" }),
    lineText: Object.freeze({ one: "4 Players game", many: "4 Players games" }),
    resultType: "teams",
    teams: Object.freeze([
      Object.freeze({ key: "A", number: 1, seats: Object.freeze([1, 2]) }),
      Object.freeze({ key: "B", number: 2, seats: Object.freeze([3, 4]) }),
    ]),
    enabled: false, // not in the Create Bill window: team billing comes in Phase 11.5
    matchEnabled: true, // two teams of two; the result is the winning team
  }),
]);

const byKey = new Map(GAME_MODES.map((mode) => [mode.key, mode]));

// Every key that can ever be stored (old bills keep theirs)
const ALL_GAME_MODE_KEYS = Object.freeze(GAME_MODES.map((mode) => mode.key));
// Keys that can be used for NEW bills right now
const ENABLED_GAME_MODE_KEYS = Object.freeze(GAME_MODES.filter((mode) => mode.enabled).map((mode) => mode.key));
// Keys that can be used for NEW matches (Phase 11.4)
const MATCH_GAME_MODE_KEYS = Object.freeze(GAME_MODES.filter((mode) => mode.matchEnabled).map((mode) => mode.key));

// "needs exactly 3 players" / "needs at least 2 players" / "needs 2 to 6 players" - from the registry limits
function playerCountRule(mode) {
  if (mode.maxPlayers === mode.minPlayers) return `exactly ${mode.minPlayers} players`;
  if (mode.maxPlayers === null) return `at least ${mode.minPlayers} players`;
  return `${mode.minPlayers} to ${mode.maxPlayers} players`;
}

function getGameMode(key) {
  return byKey.get(key) || null;
}

function isEnabledGameMode(key) {
  const mode = getGameMode(key);
  return Boolean(mode && mode.enabled);
}

function gameModeLabel(key) {
  const mode = getGameMode(key);
  return mode ? mode.label : String(key);
}

// Every pricing type a bill can have stored ("per_game" = old Century bills)
const PRICING_TYPES = Object.freeze(["per_game", "per_minute", "per_frame", "fixed"]);

// Text for the game line on a bill:
//   quantity pricing: "Century game(s)" (old bills), "Frame" / "Frames"
//   per_minute:       "Century minute(s)" - the line's quantity is the billed minutes
function gameLineDescription(key, quantity, pricingType = null) {
  const mode = getGameMode(key);
  if (!mode) return String(key);
  if (pricingType === "per_minute") return `${mode.label} ${quantity === 1 ? mode.rateUnit.one : mode.rateUnit.many}`;
  return quantity === 1 ? mode.lineText.one : mode.lineText.many;
}

// Today's rate (paisa) of a mode. In this order:
//   1. Settings.gameRates[key]  - set by an admin (Phase 11.3); 0 = switched off / not set
//   2. the mode's legacy field   - only when 1 was never set and it holds a price (Frame: framePrice > 0)
//   3. the registry default      - Century Rs 10/min, Frame Rs 250, Snooker Point Rs 350, 4 Players Rs 500
// null = unknown mode.
function rateFromSettings(key, settings) {
  const mode = getGameMode(key);
  if (!mode) return null;
  const stored = settings && settings.gameRates ? settings.gameRates[key] : undefined;
  if (Number.isInteger(stored)) return stored;
  const legacy = settings && mode.legacyRateSetting ? settings[mode.legacyRateSetting] : undefined;
  if (Number.isInteger(legacy) && legacy > 0) return legacy;
  return mode.defaultRate;
}

// { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 } - every mode's rate today
function resolveGameRates(settings) {
  return Object.fromEntries(GAME_MODES.map((mode) => [mode.key, rateFromSettings(mode.key, settings)]));
}

// "Century or Frame" / "a, b or c" - for messages built from the list
function joinOr(words) {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

// The public description of every mode, with today's rate (for GET /api/game-modes)
function describeGameModes(settings) {
  return GAME_MODES.map((mode) => {
    const rate = rateFromSettings(mode.key, settings);
    return {
      key: mode.key,
      label: mode.label,
      minPlayers: mode.minPlayers,
      maxPlayers: mode.maxPlayers,
      pricingType: mode.pricingType,
      rateUnit: { ...mode.rateUnit },
      defaultRate: mode.defaultRate,
      quantityLabel: { ...mode.quantityLabel },
      resultType: mode.resultType,
      teams: mode.teams ? mode.teams.map((team) => ({ key: team.key, seats: [...team.seats] })) : null,
      enabled: mode.enabled,
      matchEnabled: mode.matchEnabled,
      rate,                        // paisa per rateUnit (today's rate, see rateFromSettings)
      rateSet: rate !== null && rate > 0, // false = an admin set it to 0: bills for it are refused
    };
  });
}

module.exports = {
  GAME_MODES,
  ALL_GAME_MODE_KEYS,
  ENABLED_GAME_MODE_KEYS,
  MATCH_GAME_MODE_KEYS,
  PRICING_TYPES,
  playerCountRule,
  getGameMode,
  isEnabledGameMode,
  gameModeLabel,
  gameLineDescription,
  rateFromSettings,
  resolveGameRates,
  joinOr,
  describeGameModes,
};
