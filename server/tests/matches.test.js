// Tests for Phase 11.4: matches inside a session.
//   Table -> Session -> Match -> Players -> Result   (one session, MANY matches)

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const registry = require("../config/gameModes");

const TEST_DB_URI = process.env.MONGODB_MATCHES_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_matches";

let server;
let baseUrl;
let tableNumber = 0;
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
async function ok(method, path, options) {
  const result = await api(method, path, options);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
}

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);

async function openSession() {
  tableNumber += 1;
  const table = await ok("POST", "/tables", { body: { tableNumber, name: `T${tableNumber}`, hourlyRate: 1 } });
  return ok("POST", "/sessions", { body: { tableId: table.id } });
}
const player = (name) => ok("POST", "/players", { body: { name } });
const walkIn = (name, extra = {}) => ({ playerId: null, name, ...extra });
const reg = (p, extra = {}) => ({ playerId: p.id, ...extra });
const start = (session, gameMode, players, cookie) => api("POST", `/sessions/${session.id}/matches`, { body: { gameMode, players }, cookie });
const startOk = async (...args) => {
  const result = await start(...args);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
};
const complete = (match, body, cookie) => api("POST", `/matches/${match.id}/complete`, { body, cookie });
const four = (names) => names.map((name, i) => walkIn(name, { team: i < 2 ? 1 : 2 }));

let ali;
let ahmed;
let bilal;

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
  ali = await player("Ali");
  ahmed = await player("Ahmed");
  bilal = await player("Bilal");
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: all four modes can be played as matches; the Create Bill window still only offers Century and Frame", () => {
  assert.deepEqual([...registry.MATCH_GAME_MODE_KEYS], ["century", "frame", "snooker_point", "four_player"]);
  assert.deepEqual([...registry.ENABLED_GAME_MODE_KEYS], ["century", "frame"], "bill window unchanged until Phase 11.5");
  assert.deepEqual(registry.GAME_MODES.map((m) => registry.playerCountRule(m)),
    ["at least 2 players", "at least 2 players", "exactly 3 players", "exactly 4 players"]);
  assert.deepEqual(registry.getGameMode("four_player").teams.map((t) => [t.number, [...t.seats]]), [[1, [1, 2]], [2, [3, 4]]]);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

test("start: a match belongs to a session, starts in progress, copies the table and the player names", async () => {
  const session = await openSession();
  const { status, body } = await start(session, "century", [reg(ali), walkIn("  Guest   Player ")]);
  assert.equal(status, 201);
  assert.equal(body.message, "Match #1 (Century) started");
  const match = body.data;
  assert.deepEqual([match.session, match.number, match.table, match.tableNumber, match.tableName], [session.id, 1, session.table, session.tableNumber, session.tableName]);
  assert.deepEqual([match.status, match.gameMode, match.winnerSeat, match.winningTeam, match.endedAt, match.bill], ["in_progress", "century", null, null, null, null]);
  assert.deepEqual(match.players, [
    { player: ali.id, name: "Ali", seat: 1, team: null, result: null, score: null },
    { player: null, name: "Guest Player", seat: 2, team: null, result: null, score: null },
  ]);
  assert.deepEqual(match.teams, []);
  assert.ok(Math.abs(Date.parse(match.startedAt) - Date.now()) < 5000, "server clock");
  assert.equal(match.createdBy.username, "test-admin");
  assert.equal(match.rate, undefined, "no price is stored on a match");
  assert.equal(match.unitPrice, undefined);
});

test("start: one session can have many matches (#1, #2, #3 ...), each frame its own match", async () => {
  const session = await openSession();
  const numbers = [];
  for (const mode of ["frame", "frame", "frame", "century"]) numbers.push((await startOk(session, mode, [reg(ali), reg(ahmed)])).number);
  assert.deepEqual(numbers, [1, 2, 3, 4]);
  const list = await ok("GET", `/sessions/${session.id}/matches`);
  assert.deepEqual(list.map((m) => [m.number, m.gameMode]), [[1, "frame"], [2, "frame"], [3, "frame"], [4, "century"]]);
  // Another session counts from 1 again and lists only its own matches
  const other = await openSession();
  assert.equal((await startOk(other, "frame", [reg(ali), reg(ahmed)])).number, 1);
  assert.equal((await ok("GET", `/sessions/${other.id}/matches`)).length, 1);
});

test("start: 8 matches started at the same moment on one session get 8 different numbers", async () => {
  const session = await openSession();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => start(session, "frame", [walkIn(`A${i}`), walkIn(`B${i}`)])));
  assert.ok(results.every((r) => r.status === 201));
  assert.deepEqual(results.map((r) => r.body.data.number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("start: refused without an open session (unknown, ended, bad id)", async () => {
  assert.equal((await start({ id: "0123456789abcdef01234567" }, "century", [walkIn("A"), walkIn("B")])).status, 404);
  const bad = await start({ id: "nope" }, "century", [walkIn("A"), walkIn("B")]);
  assert.deepEqual([bad.status, bad.body.message], [400, "Invalid session id"]);
  const session = await openSession();
  await ok("POST", `/sessions/${session.id}/end`);
  const ended = await start(session, "century", [walkIn("A"), walkIn("B")]);
  assert.equal(ended.status, 409);
  assert.equal(ended.body.message, `The session on Table ${session.tableNumber} has ended. Start a new session to play another match.`);
  assert.equal(await db().collection("matches").countDocuments({ session: oid(session.id) }), 0);
});

test("player counts come from the registry: Century and Frame any number (2+), Snooker Point 3, 4 Players 4", async () => {
  const session = await openSession();
  const many = Array.from({ length: 6 }, (_, i) => walkIn(`P${i + 1}`));
  assert.equal((await startOk(session, "century", many)).players.length, 6, "Century is not limited to 2 players");
  assert.equal((await startOk(session, "frame", many.slice(0, 5))).players.length, 5, "Frame is not limited to 2 players");
  assert.equal((await startOk(session, "snooker_point", many.slice(0, 3))).players.length, 3);
  const cases = [
    ["century", many.slice(0, 1), "Century needs at least 2 players"],
    ["frame", many.slice(0, 1), "Frame needs at least 2 players"],
    ["snooker_point", many.slice(0, 2), "Snooker Point needs exactly 3 players"],
    ["snooker_point", many.slice(0, 4), "Snooker Point needs exactly 3 players"],
    ["four_player", four(["A", "B", "C"]), "4 Players needs exactly 4 players"],
    ["four_player", [...four(["A", "B", "C", "D"]), walkIn("E", { team: 2 })], "4 Players needs exactly 4 players"],
  ];
  for (const [mode, players, message] of cases) {
    const result = await start(session, mode, players);
    assert.deepEqual([result.status, result.body.message], [400, message], `${mode} × ${players.length}`);
  }
  const tooMany = await start(session, "century", Array.from({ length: 21 }, (_, i) => walkIn(`X${i}`)));
  assert.deepEqual([tooMany.status, tooMany.body.message], [400, "Add the players (at most 20)"]);
});

test("game type: must be a known match mode", async () => {
  const session = await openSession();
  for (const [gameMode, message] of [["pool", "Game type must be century, frame, snooker_point or four_player"],
                                     ["", "Choose Century, Frame, Snooker Point or 4 Players"]]) {
    const result = await start(session, gameMode, [walkIn("A"), walkIn("B")]);
    assert.deepEqual([result.status, result.body.message], [400, message]);
  }
});

test("players: the same registered player twice is refused; the same player in many matches is fine", async () => {
  const session = await openSession();
  const twice = await start(session, "century", [reg(ali), reg(ali), reg(ahmed)]);
  assert.deepEqual([twice.status, twice.body.message], [400, "Ali is already in this match"]);
  // Same name typed twice (walk-ins, or a walk-in with a registered player's name) is also refused: results are shown by name
  const sameName = await start(session, "century", [reg(ali), walkIn(" ali ")]);
  assert.deepEqual([sameName.status, sameName.body.message], [400, 'Each player needs a different name ("ali" is there twice)']);
  for (let i = 0; i < 3; i += 1) await startOk(session, "frame", [reg(ali), reg(bilal)]);
  const aliMatches = await db().collection("matches").countDocuments({ session: oid(session.id), "players.player": oid(ali.id) });
  assert.equal(aliMatches, 3, "Ali played three matches in this session");
});

test("players: walk-ins need a name and never create a Player or Customer; registered ids must be real and active", async () => {
  const session = await openSession();
  const playersBefore = await db().collection("players").countDocuments();
  await startOk(session, "century", [walkIn("Guest One"), walkIn("Guest Two")]);
  assert.equal(await db().collection("players").countDocuments(), playersBefore, "no Player created for walk-ins");
  assert.equal(await db().collection("customers").countDocuments(), 0, "no Customer created");

  const cases = [
    [[walkIn(""), walkIn("B")], "Each walk-in player needs a name (max 40 characters)"],
    [[{ name: "x".repeat(41) }, walkIn("B")], "Each walk-in player needs a name (max 40 characters)"],
    [[{ playerId: "abc" }, walkIn("B")], "Choose the registered player from the list"],
    [[{ playerId: "0123456789abcdef01234567" }, walkIn("B")], "A chosen player is not registered any more. Choose again."],
    [["Ali", walkIn("B")], "Each player must be a registered player or a walk-in name"],
  ];
  for (const [players, message] of cases) {
    const result = await start(session, "century", players);
    assert.equal(result.status, 400, JSON.stringify(players));
    assert.ok(result.body.message === message || result.body.errors?.some((e) => e.message === message), `${JSON.stringify(players)} -> ${JSON.stringify(result.body)}`);
  }
  const zed = await player("Zed");
  await ok("POST", `/players/${zed.id}/deactivate`);
  const inactive = await start(session, "century", [reg(zed), walkIn("B")]);
  assert.deepEqual([inactive.status, inactive.body.message], [409, "Zed is deactivated. Reactivate them on the Players page, or add them as a walk-in."]);
});

test("players: the name copy stays when the registered player is renamed or deactivated later", async () => {
  const session = await openSession();
  const temp = await player("Kamran");
  const match = await startOk(session, "century", [reg(temp), walkIn("Guest")]);
  await ok("PATCH", `/players/${temp.id}`, { body: { name: "Kamran Ali" } });
  await ok("POST", `/players/${temp.id}/deactivate`);
  const again = await ok("GET", `/matches/${match.id}`);
  assert.deepEqual([again.players[0].player, again.players[0].name], [temp.id, "Kamran"]);
});

// ---------------------------------------------------------------------------
// 4 Players: teams
// ---------------------------------------------------------------------------

test("4 Players: two teams of two; seats follow the teams whatever order the players were entered", async () => {
  const session = await openSession();
  const match = await startOk(session, "four_player", [
    walkIn("A", { team: 2 }), reg(ali, { team: 1 }), walkIn("B", { team: 1 }), reg(ahmed, { team: 2 }),
  ]);
  assert.deepEqual(match.players.map((p) => [p.seat, p.team, p.name]), [[1, 1, "Ali"], [2, 1, "B"], [3, 2, "A"], [4, 2, "Ahmed"]]);
  assert.deepEqual(match.teams, [{ number: 1, name: "Team 1", seats: [1, 2] }, { number: 2, name: "Team 2", seats: [3, 4] }]);

  const cases = [
    [walkIn("A", { team: 1 }), walkIn("B", { team: 1 }), walkIn("C", { team: 1 }), walkIn("D", { team: 2 })],
    [walkIn("A", { team: 1 }), walkIn("B", { team: 1 }), walkIn("C", { team: 2 }), walkIn("D")],
    [walkIn("A"), walkIn("B"), walkIn("C"), walkIn("D")],
  ];
  const messages = [];
  for (const players of cases) {
    const result = await start(session, "four_player", players);
    assert.equal(result.status, 400);
    messages.push(result.body.message);
  }
  assert.deepEqual(messages, [
    "Each team needs exactly 2 players (Team 1 has 3)",
    "Each team needs exactly 2 players (Team 2 has 1)",
    "Each team needs exactly 2 players (Team 1 has 0)",
  ]);
  const badTeam = await start(session, "four_player", four(["A", "B", "C", "D"]).map((p, i) => (i === 0 ? { ...p, team: 3 } : p)));
  assert.equal(badTeam.status, 400);
  assert.ok(badTeam.body.errors.some((e) => e.message === "Team must be 1 or 2"));
  const teamsElsewhere = await start(session, "century", [walkIn("A", { team: 1 }), walkIn("B", { team: 2 })]);
  assert.deepEqual([teamsElsewhere.status, teamsElsewhere.body.message], [400, "Teams are only used for 4 Players, not Century"]);
});

test("4 Players: the result is the winning team; its two players win, the other two lose", async () => {
  const session = await openSession();
  const match = await startOk(session, "four_player", four(["A", "B", "C", "D"]));
  for (const [body, message] of [[{ winningTeam: 3 }, "Winning team must be 1 or 2"], [{ winnerSeat: 1 }, "For 4 Players, choose the winning team"], [{}, "Choose the winner (or, for 4 Players, the winning team)"]]) {
    const result = await complete(match, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.ok(result.body.message === message || result.body.errors.some((e) => e.message === message), JSON.stringify(result.body));
  }
  const done = (await complete(match, { winningTeam: 2 })).body.data;
  assert.deepEqual([done.status, done.winningTeam, done.losingTeam, done.winnerSeat], ["completed", 2, 1, null]);
  assert.deepEqual(done.players.map((p) => [p.name, p.result]), [["A", "loser"], ["B", "loser"], ["C", "winner"], ["D", "winner"]]);
});

// ---------------------------------------------------------------------------
// Complete, cancel, change result
// ---------------------------------------------------------------------------

test("complete: needs a real winner from the match; winner/losers recorded with who and when", async () => {
  const session = await openSession();
  const match = await startOk(session, "snooker_point", [reg(ali), walkIn("Guest"), reg(bilal)]);
  for (const [body, message] of [[{ winnerSeat: 4 }, "Choose the winner from this match's players"], [{ winningTeam: 1 }, "Snooker Point has no teams: choose the player who won"],
                                 [{ winnerSeat: "x" }, "Choose the winner from the match's players"]]) {
    const result = await complete(match, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.message, message);
  }
  assert.equal((await ok("GET", `/matches/${match.id}`)).status, "in_progress", "refused results change nothing");

  const { status, body } = await complete(match, { winnerSeat: 2 }, cookies.cashier);
  assert.equal(status, 200);
  assert.equal(body.message, "Match #1 (Snooker Point) completed");
  const done = body.data;
  assert.deepEqual([done.status, done.winnerSeat, done.winningTeam, done.losingTeam], ["completed", 2, null, null]);
  assert.deepEqual(done.players.map((p) => [p.name, p.result]), [["Ali", "loser"], ["Guest", "winner"], ["Bilal", "loser"]]);
  assert.equal(done.resultRecordedBy.username, "test-cashier");
  assert.ok(done.endedAt && done.resultRecordedAt);
});

test("lifecycle: only in-progress matches can be completed, cancelled or edited; no reopening", async () => {
  const session = await openSession();
  const cancelled = await startOk(session, "frame", [reg(ali), reg(ahmed)]);
  const result = await api("POST", `/matches/${cancelled.id}/cancel`, { body: { reason: "Wrong table" }, cookie: cookies.staff });
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.data.status, result.body.data.cancelReason, result.body.data.cancelledBy.username], ["cancelled", "Wrong table", "test-staff"]);

  const completed = await startOk(session, "frame", [reg(ali), reg(ahmed)]);
  await complete(completed, { winnerSeat: 1 });

  const refused = [
    [await complete(cancelled, { winnerSeat: 1 }), "Match #1 is cancelled, so it can't be completed"],
    [await api("POST", `/matches/${cancelled.id}/cancel`, { body: {} }), "Match #1 is cancelled, so it can't be cancelled"],
    [await api("POST", `/matches/${cancelled.id}/result`, { body: { winnerSeat: 1 } }), "Match #1 is cancelled, so it can't be given a new result"],
    [await complete(completed, { winnerSeat: 2 }), "Match #2 is completed, so it can't be completed"],
    [await api("POST", `/matches/${completed.id}/cancel`, { body: {} }), "Match #2 is completed, so it can't be cancelled"],
    [await api("PATCH", `/matches/${completed.id}`, { body: { players: [walkIn("X"), walkIn("Y")] } }), "Match #2 is completed, so it can't be edited"],
  ];
  for (const [response, message] of refused) assert.deepEqual([response.status, response.body.message], [409, message]);
  // Nothing is ever deleted
  assert.equal((await api("DELETE", `/matches/${cancelled.id}`)).status, 404);
  assert.equal((await ok("GET", `/sessions/${session.id}/matches`)).length, 2);
});

test("complete vs cancel at the same moment: exactly one wins", async () => {
  const session = await openSession();
  const match = await startOk(session, "frame", [reg(ali), reg(ahmed)]);
  const results = await Promise.all([
    complete(match, { winnerSeat: 1 }), api("POST", `/matches/${match.id}/cancel`, { body: {} }),
    complete(match, { winnerSeat: 2 }), api("POST", `/matches/${match.id}/cancel`, { body: {} }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
});

test("edit: players (and game type) can be fixed while the match is in progress", async () => {
  const session = await openSession();
  const match = await startOk(session, "century", [reg(ali), walkIn("Guest")]);
  const edited = await ok("PATCH", `/matches/${match.id}`, { body: { players: [reg(ali), reg(ahmed), walkIn("Guest")] }, cookie: cookies.staff });
  assert.deepEqual(edited.players.map((p) => [p.seat, p.name]), [[1, "Ali"], [2, "Ahmed"], [3, "Guest"]]);
  assert.equal(edited.updatedBy.username, "test-staff");
  const toFour = await ok("PATCH", `/matches/${match.id}`, { body: { gameMode: "four_player", players: four(["A", "B", "C", "D"]) } });
  assert.deepEqual([toFour.gameMode, toFour.teams.length], ["four_player", 2]);
  const wrong = await api("PATCH", `/matches/${match.id}`, { body: { gameMode: "snooker_point", players: [walkIn("A"), walkIn("B")] } });
  assert.deepEqual([wrong.status, wrong.body.message], [400, "Snooker Point needs exactly 3 players"]);
  assert.equal((await api("PATCH", `/matches/${match.id}`, { body: { gameMode: "frame" } })).status, 400, "players are required");
});

test("change result: allowed after completion; after the bill has payments only an admin may; the bill never changes", async () => {
  const session = await openSession();
  const match = await startOk(session, "century", [reg(ali), reg(ahmed)]);
  await complete(match, { winnerSeat: 1 });
  const changed = await api("POST", `/matches/${match.id}/result`, { body: { winnerSeat: 2 }, cookie: cookies.cashier });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.message, "Result of match #1 changed");
  assert.deepEqual(changed.body.data.players.map((p) => p.result), ["loser", "winner"]);

  // The match's own bill (Phase 11.5: made from the match; until then this test linked a session bill by hand)
  await ok("POST", `/sessions/${session.id}/end`);
  const bill = await ok("POST", `/matches/${match.id}/bill`, { body: { payerRule: "loser" } }); // Ali lost -> Ali pays
  assert.equal((await ok("GET", `/matches/${match.id}`)).bill, bill.id);
  // Unpaid bill: still everyone
  assert.equal((await api("POST", `/matches/${match.id}/result`, { body: { winnerSeat: 1 }, cookie: cookies.staff })).status, 200);
  await ok("POST", `/bills/${bill.id}/payments`, { body: { amount: 100, method: "cash", payerName: "Ali" } });
  for (const role of ["staff", "cashier"]) {
    const refused = await api("POST", `/matches/${match.id}/result`, { body: { winnerSeat: 2 }, cookie: cookies[role] });
    assert.equal(refused.status, 403, role);
    assert.equal(refused.body.message, `Bill ${bill.billNumber} for this match already has payments. Only an admin can change the result.`);
  }
  const byAdmin = await api("POST", `/matches/${match.id}/result`, { body: { winnerSeat: 2 } });
  assert.equal(byAdmin.status, 200);
  const after = await ok("GET", `/bills/${bill.id}`);
  assert.deepEqual([after.total, after.amountPaid, after.players.map((p) => p.shareAmount)], [bill.total, 100, bill.players.map((p) => p.shareAmount)], "the bill is untouched");
});

// ---------------------------------------------------------------------------
// Permissions, old data, indexes
// ---------------------------------------------------------------------------

test("permissions: everyone views, starts and completes; cancel is admin/staff; logged out 401", async () => {
  const session = await openSession();
  for (const role of ["admin", "staff", "cashier"]) {
    const match = await startOk(session, "century", [walkIn(`${role} A`), walkIn(`${role} B`)], cookies[role]);
    assert.equal((await api("GET", `/matches/${match.id}`, { cookie: cookies[role] })).status, 200);
    assert.equal((await api("GET", `/sessions/${session.id}/matches`, { cookie: cookies[role] })).status, 200);
    const cancel = await api("POST", `/matches/${match.id}/cancel`, { body: {}, cookie: cookies[role] });
    assert.equal(cancel.status, role === "cashier" ? 403 : 200, role);
  }
  const anonymous = await api("GET", `/sessions/${session.id}/matches`, { cookie: null });
  assert.deepEqual([anonymous.status, anonymous.body.message], [401, "Please log in to continue."]);
  assert.equal((await start(session, "century", [walkIn("A"), walkIn("B")], null)).status, 401);
  assert.equal((await api("GET", "/matches/nope")).status, 400);
  assert.equal((await api("GET", "/matches/0123456789abcdef01234567")).status, 404);
  assert.equal((await api("GET", "/sessions/0123456789abcdef01234567/matches")).status, 404);
});

test("old data keeps working: sessions without matches end and bill as before; bills ignore matches", async () => {
  const session = await openSession();
  const ended = await ok("POST", `/sessions/${session.id}/end`);
  assert.equal(ended.status, "completed");
  const bill = await api("POST", "/bills", { body: { sessionId: session.id, gameMode: "frame", quantity: 2, payerRule: "split", players: [{ name: "A" }, { name: "B" }] } });
  assert.equal(bill.status, 201);
  assert.equal(bill.body.data.total, 50000, "Frame 2 × Rs 250 - unchanged");
  assert.deepEqual(await ok("GET", `/sessions/${session.id}/matches`), [], "no fake matches made for old sessions");
  // A session with an in-progress match can still be ended; the match is completed afterwards and then billed.
  // (Phase 11.5: a session with matches is billed match by match - a whole-session bill is refused.)
  const busy = await openSession();
  const match = await startOk(busy, "century", [reg(ali), reg(ahmed)]);
  await ok("POST", `/sessions/${busy.id}/end`);
  assert.equal((await complete(match, { winnerSeat: 1 })).status, 200, "a match can be completed after its session ended");
  assert.equal((await api("POST", "/bills", { body: { sessionId: busy.id, gameMode: "century", quantity: 1, payerRule: "split", players: [{ name: "A" }, { name: "B" }] } })).status, 409);
  assert.equal((await api("POST", `/matches/${match.id}/bill`, { body: { payerRule: "split" } })).status, 201);
  // The game-mode list still serves the bill window as before
  const modes = await ok("GET", "/game-modes", { cookie: cookies.cashier });
  assert.deepEqual(modes.filter((m) => m.enabled).map((m) => m.key), ["century", "frame"]);
  assert.ok(modes.every((m) => m.matchEnabled === true));
});

test("indexes: match numbers are unique per session; the history lookups have indexes", async () => {
  const indexes = await db().collection("matches").indexes();
  const keys = indexes.map((i) => JSON.stringify(i.key));
  assert.ok(indexes.some((i) => JSON.stringify(i.key) === '{"session":1,"number":1}' && i.unique));
  for (const key of ['{"session":1,"status":1}', '{"players.player":1,"startedAt":-1}', '{"gameMode":1,"startedAt":-1}']) assert.ok(keys.includes(key), key);
});
