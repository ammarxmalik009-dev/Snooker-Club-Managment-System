// Tests for Phase 11.1: the central game-mode registry (config/gameModes.js) and GET /api/game-modes.
// Phase 11.1 must not change any behaviour: Century and Frame bill exactly as before,
// Snooker Point and 4 Players are known but disabled.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const registry = require("../config/gameModes");
const { calculateBill, GAME_LABELS } = require("../services/billing.calculator");
const { GAME_MODES: BILL_GAME_MODES } = require("../models/Bill");

const TEST_DB_URI = process.env.MONGODB_GAMEMODES_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_gamemodes";

let server;
let baseUrl;
const cookies = {};

async function api(method, path, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["admin", "staff", "cashier"]) cookies[role] = await loginAs(baseUrl, role);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test("registry: the four modes, their labels and pricing metadata", () => {
  assert.deepEqual(registry.ALL_GAME_MODE_KEYS, ["century", "frame", "snooker_point", "four_player"]);
  const summary = registry.GAME_MODES.map((m) => [m.key, m.label, m.pricingType, m.minPlayers, m.maxPlayers, m.resultType, m.enabled]);
  assert.deepEqual(summary, [
    ["century", "Century", "per_minute", 2, null, "winner_loser", true],      // per game until Phase 11.3
    ["frame", "Frame", "per_frame", 2, null, "winner_loser", true],
    ["snooker_point", "Snooker Point", "fixed", 3, 3, "winner_loser", false],
    ["four_player", "4 Players", "fixed", 4, 4, "teams", false],
  ]);
  assert.deepEqual(registry.getGameMode("four_player").teams.map((t) => [t.key, [...t.seats]]), [["A", [1, 2]], ["B", [3, 4]]]);
  assert.equal(registry.getGameMode("pool"), null);
  assert.deepEqual(registry.ENABLED_GAME_MODE_KEYS, ["century", "frame"]);
  assert.equal(registry.isEnabledGameMode("frame"), true);
  assert.equal(registry.isEnabledGameMode("snooker_point"), false);
  assert.equal(registry.isEnabledGameMode("nope"), false);
  // The registry can't be changed by accident at run time
  assert.throws(() => { "use strict"; registry.GAME_MODES[0].label = "X"; });
});

test("registry: bill line texts, labels and settings rates are exactly what Phase 5-10 used", () => {
  assert.equal(registry.gameLineDescription("century", 1), "Century game");
  assert.equal(registry.gameLineDescription("century", 3), "Century games");
  assert.equal(registry.gameLineDescription("frame", 1), "Frame");
  assert.equal(registry.gameLineDescription("frame", 2), "Frames");
  assert.deepEqual({ century: GAME_LABELS.century, frame: GAME_LABELS.frame }, { century: "Century", frame: "Frame" });
  assert.equal(registry.gameModeLabel("unknown_mode"), "unknown_mode");
  // Rates (changed in Phase 11.3 - see gamePricing.test.js): framePrice still counts as the Frame rate;
  // the old per-GAME centuryPrice no longer prices Century (now per minute, default Rs 10).
  const settings = { centuryPrice: 30000, framePrice: 15000 };
  assert.equal(registry.rateFromSettings("century", settings), 1000);
  assert.equal(registry.rateFromSettings("frame", settings), 15000);
  assert.equal(registry.rateFromSettings("snooker_point", settings), 35000, "default rate since Phase 11.3");
  // Without a pricingType the calculator still builds exactly the old bill (quantity × rate)
  const bill = calculateBill({ gameMode: "century", quantity: 3, unitPrice: 30000, payerRule: "split", players: [{ name: "A" }, { name: "B" }] });
  assert.deepEqual(bill.lineItems, [{ type: "game", description: "Century games", quantity: 3, unitPrice: 30000, amount: 90000 }]);
  // The Bill model can store every registry key (old and future bills)
  assert.deepEqual([...BILL_GAME_MODES], registry.ALL_GAME_MODE_KEYS);
  assert.equal(registry.joinOr(["Century", "Frame"]), "Century or Frame");
  assert.equal(registry.joinOr(["a", "b", "c"]), "a, b or c");
});

test("browser helpers (format.js): labels and units come from the registry, readable fallback before loading", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "client", "js", "core", "format.js"), "utf8");
  let calls = 0;
  const sandbox = {
    exports: {}, Intl, Date,
    apiRequest: async (url) => {
      calls += 1;
      assert.equal(url, "/game-modes");
      return { data: registry.describeGameModes({ centuryPrice: 30000, framePrice: 15000 }) };
    },
  };
  vm.runInNewContext(`${source}; Object.assign(globalThis.exports, { loadGameModes, gameModeLabel, gameModeQuantityLabel });`, sandbox);
  const { loadGameModes, gameModeLabel, gameModeQuantityLabel } = sandbox.exports;
  // Before the registry has arrived: readable keys (old bills always show something sensible)
  assert.equal(gameModeLabel("century"), "Century");
  assert.equal(gameModeLabel("four_player"), "Four player");
  assert.equal(gameModeQuantityLabel("frame"), "played");
  await loadGameModes();
  await loadGameModes();
  assert.equal(calls, 1, "loaded once per page");
  assert.equal(gameModeLabel("four_player"), "4 Players");
  assert.equal(gameModeLabel("frame"), "Frame");
  assert.equal(gameModeQuantityLabel("frame"), "frames");
  assert.equal(gameModeQuantityLabel("century", 1), "game");
  assert.equal(gameModeLabel("some_old_mode"), "Some old mode");
});

// ---------------------------------------------------------------------------
// GET /api/game-modes
// ---------------------------------------------------------------------------

test("GET /api/game-modes: every role can read it, logged out gets 401", async () => {
  for (const role of ["admin", "staff", "cashier"]) {
    const { status, body } = await api("GET", "/game-modes", { cookie: cookies[role] });
    assert.equal(status, 200, role);
    assert.equal(body.data.length, 4);
  }
  const anonymous = await api("GET", "/game-modes", { cookie: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.message, "Please log in to continue.");
});

test("GET /api/game-modes: labels, metadata and today's rates from Settings", async () => {
  let modes = (await api("GET", "/game-modes")).body.data;
  const byKey = Object.fromEntries(modes.map((m) => [m.key, m]));
  assert.deepEqual(modes.map((m) => m.label), ["Century", "Frame", "Snooker Point", "4 Players"]);
  // Phase 11.3: per minute, with the default rate (before: per_game, rate 0 = not set)
  assert.deepEqual(byKey.century, {
    key: "century", label: "Century", minPlayers: 2, maxPlayers: null, pricingType: "per_minute",
    rateUnit: { one: "minute", many: "minutes" }, defaultRate: 1000,
    quantityLabel: { one: "game", many: "games" }, resultType: "winner_loser", teams: null, enabled: true,
    matchEnabled: true, // Phase 11.4
    rate: 1000, rateSet: true,
  });
  assert.deepEqual(byKey.four_player.teams, [{ key: "A", seats: [1, 2] }, { key: "B", seats: [3, 4] }]);
  assert.deepEqual([byKey.snooker_point.rate, byKey.snooker_point.rateSet, byKey.snooker_point.enabled], [35000, true, false]);
  assert.ok(modes.every((m) => !("legacyRateSetting" in m) && !("lineText" in m)), "internal details are not sent");

  await api("PATCH", "/settings", { body: { gameRates: { century: 1200 }, framePrice: 15000 } });
  modes = (await api("GET", "/game-modes")).body.data;
  assert.deepEqual(modes.filter((m) => m.enabled).map((m) => [m.key, m.rate, m.rateSet]), [["century", 1200, true], ["frame", 15000, true]]);
});

test("behaviour unchanged: bills accept only the enabled modes, with the same messages", async () => {
  await api("PATCH", "/settings", { body: { gameRates: { century: 1000 }, framePrice: 15000 } });
  const table =(await api("POST", "/tables", { body: { tableNumber: 1, hourlyRate: 1 } })).body.data;
  const session = (await api("POST", "/sessions", { body: { tableId: table.id } })).body.data;
  await api("POST", `/sessions/${session.id}/end`);
  const base = { sessionId: session.id, quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] };
  for (const mode of ["snooker_point", "four_player", "pool"]) {
    const { status, body } = await api("POST", "/bills/preview", { body: { ...base, gameMode: mode } });
    assert.equal(status, 400, mode);
    assert.equal(body.message, "Game type must be century or frame");
  }
  assert.equal((await api("POST", "/bills/preview", { body: { ...base, gameMode: "" } })).body.message, "Choose Century or Frame");
  const frame = await api("POST", "/bills", { body: { ...base, gameMode: "frame", quantity: 2 } });
  assert.equal(frame.status, 201);
  assert.deepEqual(frame.body.data.lineItems[0], { type: "game", description: "Frames", quantity: 2, unitPrice: 15000, amount: 30000 });
  // Report filters: since Phase 11.5 every game type can be on a bill (match bills), so since Phase 11.7
  // the Reports filter accepts and offers all four registry types (unknown types are still refused)
  assert.equal((await api("GET", "/reports/revenue?gameMode=four_player")).status, 200);
  assert.equal((await api("GET", "/reports/revenue?gameMode=pool")).status, 400);
  assert.deepEqual((await api("GET", "/reports/options")).body.data.gameModes, ["century", "frame", "snooker_point", "four_player"]);
});
