// Business rules for matches (Phase 11.4).
//
//   Table -> Session -> Match -> Players -> Result
//
// - A match is started on an OPEN session; a session can have any number of matches.
// - Player limits and teams come from the game-mode registry (config/gameModes.js) only.
// - Registered players are referenced AND their name is copied; walk-ins are stored by name only.
//   Nothing here ever creates a Player or a Customer.
// - Lifecycle: in_progress -> completed | cancelled. Nothing else (no reopening).
// - No prices and no bill maths here: the bill (Phase 11.5) copies the rate when it is created.
// - Every change of state is ONE conditional database update, so two people pressing
//   "Complete" and "Cancel" at the same moment can't both win.

const { Match } = require("../models/Match");
const { Session } = require("../models/Session");
const { Player } = require("../models/Player");
const { Bill } = require("../models/Bill");
const { nameKeyOf } = require("../models/Category");
const { nextSequence } = require("../models/Counter");
const { actorFrom } = require("../models/schemas/actor");
const { roleHasPermission } = require("../config/permissions");
const { getGameMode, playerCountRule } = require("../config/gameModes");
const AppError = require("../utils/AppError");

const tidy = (value) => String(value || "").trim().replace(/\s+/g, " ");
const STATUS_WORDS = { in_progress: "in progress", completed: "completed", cancelled: "cancelled" };

// ---------- Players and teams ----------

// input: [{ playerId?, name?, team? }] in the order they were entered.
// Returns { players: [{ player, name, seat, team, result, score }], teams: [...] }
async function resolvePlayers(mode, input) {
  if (input.length < mode.minPlayers || (mode.maxPlayers !== null && input.length > mode.maxPlayers)) {
    throw new AppError(`${mode.label} needs ${playerCountRule(mode)}`, 400, [{ field: "players", message: `${mode.label} needs ${playerCountRule(mode)}` }]);
  }

  // Registered players: each one only once, must exist and be active
  const ids = input.filter((p) => p.playerId).map((p) => String(p.playerId));
  const seenIds = new Set();
  for (const id of ids) {
    if (seenIds.has(id)) {
      const player = await Player.findById(id).select("name");
      const message = `${player ? player.name : "This player"} is already in this match`;
      throw new AppError(message, 400, [{ field: "players", message }]);
    }
    seenIds.add(id);
  }
  const registered = await Player.find({ _id: { $in: ids } }).select("name isActive");
  const byId = new Map(registered.map((p) => [String(p._id), p]));
  for (const id of ids) {
    const player = byId.get(id);
    if (!player) throw new AppError("A chosen player is not registered any more. Choose again.", 400, [{ field: "players", message: "Choose the player from the list again" }]);
    if (!player.isActive) {
      throw new AppError(`${player.name} is deactivated. Reactivate them on the Players page, or add them as a walk-in.`, 409, [{ field: "players", message: `${player.name} is deactivated` }]);
    }
  }

  // Name copy: a registered player's CURRENT name; a walk-in's typed name
  const entries = input.map((p) => ({
    player: p.playerId ? byId.get(String(p.playerId))._id : null,
    name: p.playerId ? byId.get(String(p.playerId)).name : tidy(p.name),
    team: p.team === undefined || p.team === null ? null : Number(p.team),
  }));
  const names = new Set();
  for (const entry of entries) {
    const key = nameKeyOf(entry.name);
    if (names.has(key)) {
      const message = `Each player needs a different name ("${entry.name}" is there twice)`;
      throw new AppError(message, 400, [{ field: "players", message }]);
    }
    names.add(key);
  }

  if (mode.resultType !== "teams") {
    if (entries.some((e) => e.team !== null)) {
      throw new AppError(`Teams are only used for 4 Players, not ${mode.label}`, 400, [{ field: "players", message: "Remove the team choices" }]);
    }
    return { players: entries.map((e, i) => ({ ...e, seat: i + 1, result: null, score: null })), teams: [] };
  }

  // Team mode: every player in exactly one team, each team exactly as many players as it has seats (2 + 2)
  const players = [];
  const teams = [];
  for (const team of mode.teams) {
    const members = entries.filter((e) => e.team === team.number);
    if (members.length !== team.seats.length) {
      const message = `Each team needs exactly ${team.seats.length} players (Team ${team.number} has ${members.length})`;
      throw new AppError(message, 400, [{ field: "players", message }]);
    }
    members.forEach((member, i) => players.push({ ...member, seat: team.seats[i], result: null, score: null }));
    teams.push({ number: team.number, name: `Team ${team.number}`, seats: [...team.seats] });
  }
  if (players.length !== entries.length) {
    throw new AppError("Put every player in Team 1 or Team 2", 400, [{ field: "players", message: "Every player needs a team" }]);
  }
  players.sort((a, b) => a.seat - b.seat);
  return { players, teams };
}

// ---------- Result ----------

// { winnerSeat } for player modes, { winningTeam } for team modes -> the fields to save
function resultFields(match, { winnerSeat, winningTeam }) {
  const mode = getGameMode(match.gameMode);
  if (mode.resultType === "teams") {
    if (winnerSeat !== undefined && winnerSeat !== null) {
      throw new AppError("For 4 Players, choose the winning team", 400, [{ field: "winningTeam", message: "Choose Team 1 or Team 2" }]);
    }
    const team = match.teams.find((t) => t.number === winningTeam);
    if (!team) throw new AppError("Choose the winning team: Team 1 or Team 2", 400, [{ field: "winningTeam", message: "Choose Team 1 or Team 2" }]);
    const losing = match.teams.find((t) => t.number !== winningTeam);
    return {
      winningTeam: team.number,
      losingTeam: losing.number,
      winnerSeat: null,
      players: match.players.map((p) => ({ ...plain(p), result: p.team === team.number ? "winner" : "loser" })),
    };
  }
  if (winningTeam !== undefined && winningTeam !== null) {
    throw new AppError(`${mode.label} has no teams: choose the player who won`, 400, [{ field: "winnerSeat", message: "Choose the winner" }]);
  }
  if (!match.players.some((p) => p.seat === winnerSeat)) {
    throw new AppError("Choose the winner from this match's players", 400, [{ field: "winnerSeat", message: "Choose the winner" }]);
  }
  return {
    winnerSeat,
    winningTeam: null,
    losingTeam: null,
    players: match.players.map((p) => ({ ...plain(p), result: p.seat === winnerSeat ? "winner" : "loser" })),
  };
}

const plain = (p) => ({ player: p.player || null, name: p.name, seat: p.seat, team: p.team ?? null, result: p.result ?? null, score: p.score ?? null });

// ---------- Helpers ----------

async function findMatch(id) {
  const match = await Match.findById(id);
  if (!match) throw new AppError("Match not found", 404);
  return match;
}

function stateError(match, wanted) {
  return new AppError(`Match #${match.number} is ${STATUS_WORDS[match.status]}, so it can't be ${wanted}`, 409);
}

// One conditional update. `expected` = the state the change was worked out from;
// if someone else changed the match in the meantime, nothing is saved and the user is told.
async function saveIfUnchanged(match, expected, changes, wanted) {
  const updated = await Match.findOneAndUpdate(
    { _id: match._id, ...expected },
    { $set: changes },
    { returnDocument: "after", runValidators: true }
  );
  if (updated) return updated;
  const now = await findMatch(match._id);
  if (now.status !== match.status) throw stateError(now, wanted);
  throw new AppError(`Match #${match.number} was just changed by someone else. Check it and try again.`, 409);
}

// ---------- Start ----------

async function startMatch(sessionId, { gameMode, players: input }, actorUser = null) {
  const session = await Session.findById(sessionId);
  if (!session) throw new AppError("Session not found", 404);
  if (!session.isOpen) {
    throw new AppError(`The session on Table ${session.tableNumber} has ended. Start a new session to play another match.`, 409);
  }
  const mode = getGameMode(gameMode);
  const { players, teams } = await resolvePlayers(mode, input);

  const actor = actorFrom(actorUser);
  const number = await nextSequence(`match-${session._id}`); // #1, #2 ... (atomic)
  const match = await Match.create({
    session: session._id, number, table: session.table, tableNumber: session.tableNumber, tableName: session.tableName,
    gameMode, players, teams, status: "in_progress", startedAt: new Date(), createdBy: actor, updatedBy: actor,
  });

  // The session may have ended at the very moment the match was saved: then the match is taken back
  const stillOpen = await Session.exists({ _id: session._id, isOpen: true });
  if (!stillOpen) {
    await Match.deleteOne({ _id: match._id });
    throw new AppError(`The session on Table ${session.tableNumber} has just ended. Start a new session to play another match.`, 409);
  }
  return match;
}

// ---------- The match's bill (Phase 11.8) ----------
// The BILL is the source of truth: a match bill carries `match` (and the database allows one bill per
// match). Match.bill is only a convenience pointer, written right after the bill is saved - if that
// second write never happened (a crash in between), the pointer is missing. So every decision looks
// the bill up by its `match` reference, and a missing pointer is repaired on the way (without touching
// updatedAt, so a result change in progress isn't mistaken for someone else's edit). Bills are never
// changed or created here.

async function repairBillPointer(matchId, billId) {
  await Match.updateOne({ _id: matchId, bill: null }, { $set: { bill: billId } }, { timestamps: false });
}

async function findMatchBill(match) {
  const bill = await Bill.findOne({ match: match._id }).select("billNumber status total amountPaid");
  if (bill && !match.bill) await repairBillPointer(match._id, bill._id);
  return bill;
}

// ---------- Read ----------

async function listMatchesForSession(sessionId) {
  const session = await Session.findById(sessionId).select("_id");
  if (!session) throw new AppError("Session not found", 404);
  const matches = await Match.find({ session: session._id }).sort({ number: 1 });
  // Phase 11.5: each match's bill (number, status, money) for the Matches window - one query for all.
  // Phase 11.8: found by the bills' own match reference (not Match.bill), missing pointers repaired.
  const bills = matches.length
    ? await Bill.find({ session: session._id, match: { $in: matches.map((m) => m._id) } }).select("match billNumber status total amountPaid")
    : [];
  const billByMatch = new Map(bills.map((b) => [String(b.match), b]));
  await Promise.all(matches.filter((m) => !m.bill && billByMatch.has(String(m._id)))
    .map((m) => repairBillPointer(m._id, billByMatch.get(String(m._id))._id)));
  return matches.map((m) => {
    const b = billByMatch.get(String(m._id));
    const billInfo = b ? { id: String(b._id), billNumber: b.billNumber, status: b.status, total: b.total, amountPaid: b.amountPaid } : null;
    return { ...m.toJSON(), bill: b ? String(b._id) : null, billInfo };
  });
}

// Phase 11.5: per session, how its matches stand - for the session history and dashboard
// { total, inProgress, completed, cancelled, billed }
// billed (Phase 11.8) = matches whose bill is NOT cancelled - the same meaning as the Matches report.
// Counted from the bills themselves ({session, match} index), so a missing Match.bill pointer can't hide one.
async function matchSummaryForSessions(sessionIds) {
  const [rows, billRows] = await Promise.all([
    Match.aggregate([
      { $match: { session: { $in: sessionIds } } },
      {
        $group: {
          _id: "$session",
          total: { $sum: 1 },
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        },
      },
    ]),
    Bill.aggregate([
      { $match: { session: { $in: sessionIds }, match: { $type: "objectId" }, status: { $ne: "cancelled" } } },
      { $group: { _id: "$session", billed: { $sum: 1 } } },
    ]),
  ]);
  const billed = new Map(billRows.map((row) => [String(row._id), row.billed]));
  return new Map(rows.map(({ _id, ...summary }) => [String(_id), { ...summary, billed: billed.get(String(_id)) || 0 }]));
}

async function getMatchById(id) {
  return findMatch(id);
}

// ---------- Edit players (only while in progress) ----------

async function updateMatch(id, { gameMode, players: input }, actorUser = null) {
  const match = await findMatch(id);
  if (match.status !== "in_progress") throw stateError(match, "edited");
  const mode = getGameMode(gameMode || match.gameMode);
  const { players, teams } = await resolvePlayers(mode, input);
  return saveIfUnchanged(match, { status: "in_progress", updatedAt: match.updatedAt },
    { gameMode: mode.key, players, teams, updatedBy: actorFrom(actorUser) }, "edited");
}

// ---------- Complete / cancel ----------

async function completeMatch(id, result, actorUser = null) {
  const match = await findMatch(id);
  if (match.status !== "in_progress") throw stateError(match, "completed");
  const now = new Date();
  const actor = actorFrom(actorUser);
  return saveIfUnchanged(match, { status: "in_progress", updatedAt: match.updatedAt }, {
    ...resultFields(match, result),
    status: "completed", endedAt: now, resultRecordedAt: now, resultRecordedBy: actor, updatedBy: actor,
  }, "completed");
}

async function cancelMatch(id, { reason = "" } = {}, actorUser = null) {
  const match = await findMatch(id);
  if (match.status !== "in_progress") throw stateError(match, "cancelled");
  const now = new Date();
  const actor = actorFrom(actorUser);
  return saveIfUnchanged(match, { status: "in_progress" }, {
    status: "cancelled", endedAt: now, cancelledAt: now, cancelledBy: actor, cancelReason: reason, updatedBy: actor,
  }, "cancelled");
}

// ---------- Change the result of a completed match ----------
// Allowed later too (mistakes happen). Once the match's bill has payments (partly or fully paid),
// only an admin may do it. It never changes a bill: by design the bill keeps the result it was made with.
// Phase 11.8: the bill is found by its own `match` reference, so a missing Match.bill pointer can never
// let staff or a cashier change the result of a paid match.
async function changeResult(id, result, actorUser) {
  const match = await findMatch(id);
  if (match.status !== "completed") throw stateError(match, "given a new result");
  const bill = await findMatchBill(match);
  if (bill && bill.amountPaid > 0 && !roleHasPermission(actorUser.role, "matches:correct-paid")) {
    throw new AppError(`Bill ${bill.billNumber} for this match already has payments. Only an admin can change the result.`, 403);
  }
  const now = new Date();
  const actor = actorFrom(actorUser);
  return saveIfUnchanged(match, { status: "completed", updatedAt: match.updatedAt }, {
    ...resultFields(match, result), resultRecordedAt: now, resultRecordedBy: actor, updatedBy: actor,
  }, "given a new result");
}

module.exports = {
  startMatch,
  listMatchesForSession,
  matchSummaryForSessions,
  getMatchById,
  updateMatch,
  completeMatch,
  cancelMatch,
  changeResult,
  findMatchBill,
  repairBillPointer,
};
