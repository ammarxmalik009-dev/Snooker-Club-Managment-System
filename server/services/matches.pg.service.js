// Matches - PostgreSQL pilot (Phase 2, step 2.14). Standalone: not wired into any route, does
// not call and is not called by server/services/matches.service.js (MongoDB), which stays the
// application's only active path.
//
// Reused, unmodified: server/config/gameModes.js (pure config, no mongoose) - the exact same
// player-limit/team/result-type rules matches.service.js itself reads from; and
// server/services/players.pg.service.js's own nameKeyOf (a PostgreSQL pilot file already, so
// requiring it here adds no mongoose to this file's require tree).
//
// Starting a match is MORE robust here, not a copy of the MongoDB workaround: matches.service.js
// creates the match first, then re-checks the session is still open, and DELETES the just-created
// match if it was not (a documented compensating step - the session could have ended in the
// instant between the check and the save). Here, the session row is locked with
// `SELECT ... FOR UPDATE` BEFORE the match is created, inside one transaction - a concurrent
// `endSession` (sessions.pg.service.js's own transaction) blocks on that same row until this
// transaction commits or rolls back, so there is no window where a match could ever be created on
// a session that has just closed. No compensating delete exists or is needed.
//
// Explicitly OUT OF SCOPE (recorded, not invented):
//  - listMatchesForSession's / matchSummaryForSessions's own BILL joins (matches.service.js loads
//    bills.service.js for this) - deferred the same way step 2.12's Sessions pilot deferred its
//    own bill/match joins. bills.pg.service.js (step 2.6) exists, but joining it in here would
//    mean reimplementing matches.service.js's billing-adjacent report logic as a side effect of a
//    Matches pilot, against this step's own instruction not to.
//  - changeResult (matches.service.js's own "change a completed match's result") - it depends on
//    BOTH a Bill lookup (bills.pg.service.js) AND server/config/permissions.js's roleHasPermission
//    (an authorization decision, not a repository concern). Neither dependency belongs inside a
//    standalone Matches repository, so this operation is deferred rather than reimplemented here.

const { query, withTransaction } = require("../config/db.pg");
const { toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { nameKeyOf } = require("./players.pg.service");
const { getGameMode, playerCountRule } = require("../config/gameModes");
const AppError = require("../utils/AppError");

const MATCH_STATUSES = ["in_progress", "completed", "cancelled"];
const STATUS_WORDS = { in_progress: "in progress", completed: "completed", cancelled: "cancelled" };

const tidy = (value) => String(value || "").trim().replace(/\s+/g, " ");

function mapMatchRow(row, players = [], teams = []) {
  if (!row) return null;
  return {
    id: toId(row.id),
    session: toId(row.session_id),
    number: row.number,
    table: toId(row.table_id),
    tableNumber: row.table_number,
    tableName: row.table_name,
    gameMode: row.game_mode,
    players: players.map(mapMatchPlayerRow).sort((a, b) => a.seat - b.seat),
    teams: teams.map(mapMatchTeamRow).sort((a, b) => a.number - b.number),
    status: row.status,
    winnerSeat: row.winner_seat,
    winningTeam: row.winning_team,
    losingTeam: row.losing_team,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    resultRecordedAt: row.result_recorded_at,
    resultRecordedBy: actorFromRow(row, "result_recorded_by"),
    cancelledAt: row.cancelled_at,
    cancelledBy: actorFromRow(row, "cancelled_by"),
    cancelReason: row.cancel_reason,
    bill: toId(row.bill_id) || null,
    createdBy: actorFromRow(row, "created_by"),
    updatedBy: actorFromRow(row, "updated_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMatchPlayerRow(row) {
  return {
    player: toId(row.player_id) || null,
    name: row.name,
    seat: row.seat,
    team: row.team,
    result: row.result,
    score: row.score,
  };
}

function mapMatchTeamRow(row) {
  return { number: row.number, name: row.name, seats: row.seats };
}

async function loadPlayersAndTeams(client, matchId) {
  const players = await client.query("SELECT * FROM app.match_players WHERE match_id = $1 ORDER BY seat", [matchId]);
  const teams = await client.query("SELECT * FROM app.match_teams WHERE match_id = $1 ORDER BY number", [matchId]);
  return { players: players.rows, teams: teams.rows };
}

// Same rules as matches.service.js's own resolvePlayers: player-count limits from the game-mode
// registry, each registered player only once and active, every name unique (registered or
// walk-in), and - for team modes - every player in exactly one team with exactly the right number
// of seats. Returns { players: [{player, name, seat, team}], teams: [{number, name, seats}] }.
async function resolvePlayers(client, mode, input) {
  if (input.length < mode.minPlayers || (mode.maxPlayers !== null && input.length > mode.maxPlayers)) {
    const message = `${mode.label} needs ${playerCountRule(mode)}`;
    throw new AppError(message, 400, [{ field: "players", message }]);
  }

  const ids = input.filter((p) => p.playerId).map((p) => String(p.playerId));
  const seenIds = new Set();
  for (const id of ids) {
    if (seenIds.has(id)) {
      const found = await client.query("SELECT name FROM app.players WHERE id = $1", [id]);
      const message = `${found.rows[0] ? found.rows[0].name : "This player"} is already in this match`;
      throw new AppError(message, 400, [{ field: "players", message }]);
    }
    seenIds.add(id);
  }

  const byId = new Map();
  if (ids.length > 0) {
    const registered = await client.query("SELECT id, name, is_active FROM app.players WHERE id = ANY($1::uuid[])", [ids]);
    for (const row of registered.rows) byId.set(row.id, row);
  }
  for (const id of ids) {
    const player = byId.get(id);
    if (!player) throw new AppError("A chosen player is not registered any more. Choose again.", 400, [{ field: "players", message: "Choose the player from the list again" }]);
    if (!player.is_active) {
      const message = `${player.name} is deactivated. Reactivate them on the Players page, or add them as a walk-in.`;
      throw new AppError(message, 409, [{ field: "players", message }]);
    }
  }

  const entries = input.map((p) => ({
    player: p.playerId ? String(p.playerId) : null,
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
    return { players: entries.map((e, i) => ({ ...e, seat: i + 1 })), teams: [] };
  }

  const players = [];
  const teams = [];
  for (const team of mode.teams) {
    const members = entries.filter((e) => e.team === team.number);
    if (members.length !== team.seats.length) {
      const message = `Each team needs exactly ${team.seats.length} players (Team ${team.number} has ${members.length})`;
      throw new AppError(message, 400, [{ field: "players", message }]);
    }
    members.forEach((member, i) => players.push({ ...member, seat: team.seats[i] }));
    teams.push({ number: team.number, name: `Team ${team.number}`, seats: [...team.seats] });
  }
  if (players.length !== entries.length) {
    throw new AppError("Put every player in Team 1 or Team 2", 400, [{ field: "players", message: "Every player needs a team" }]);
  }
  players.sort((a, b) => a.seat - b.seat);
  return { players, teams };
}

async function insertPlayersAndTeams(client, matchId, players, teams) {
  for (const [index, player] of players.entries()) {
    await client.query(
      `INSERT INTO app.match_players (match_id, position, player_id, name, seat, team)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [matchId, index, player.player, player.name, player.seat, player.team]
    );
  }
  for (const team of teams) {
    await client.query(
      `INSERT INTO app.match_teams (match_id, number, name, seats) VALUES ($1, $2, $3, $4)`,
      [matchId, team.number, team.name, team.seats]
    );
  }
}

async function getMatchById(id) {
  const result = await query("SELECT * FROM app.matches WHERE id = $1", [id]);
  if (result.rows.length === 0) throw new AppError("Match not found", 404);
  const { players, teams } = await loadPlayersAndTeams({ query: (text, params) => query(text, params) }, id);
  return mapMatchRow(result.rows[0], players, teams);
}

function stateError(number, status, wanted) {
  return new AppError(`Match #${number} is ${STATUS_WORDS[status]}, so it can't be ${wanted}`, 409);
}

// Start a match: locks the session row FOR UPDATE before creating anything (see this file's own
// header comment for why this is stronger than matches.service.js's create-then-maybe-delete
// dance), assigns the next match number for the session with the same atomic-counter pattern
// models/Counter.js uses, and inserts the match + its players/teams - all inside ONE transaction.
async function startMatch({ sessionId, gameMode, players: input }, actorUser = null) {
  const mode = getGameMode(gameMode);
  if (!mode) throw new AppError("Unknown game mode", 400, [{ field: "gameMode", message: "Choose a valid game mode" }]);

  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const sessionResult = await client.query("SELECT * FROM app.sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    if (sessionResult.rows.length === 0) throw new AppError("Session not found", 404);
    const session = sessionResult.rows[0];
    if (!session.is_open) {
      throw new AppError(`The session on Table ${session.table_number} has ended. Start a new session to play another match.`, 409);
    }

    const { players, teams } = await resolvePlayers(client, mode, input);

    const counter = await client.query(
      `INSERT INTO app.counters (id, seq) VALUES ($1, 1)
       ON CONFLICT (id) DO UPDATE SET seq = app.counters.seq + 1
       RETURNING seq`,
      [`match-${sessionId}`]
    );
    const number = Number(counter.rows[0].seq);

    const matchResult = await client.query(
      `INSERT INTO app.matches (session_id, number, table_id, table_number, table_name, game_mode,
                                 created_by_user_id, created_by_name, created_by_username,
                                 updated_by_user_id, updated_by_name, updated_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7, $8, $9)
       RETURNING *`,
      [sessionId, number, session.table_id, session.table_number, session.table_name, gameMode, userId, actor ? actor.name : null, actor ? actor.username : null]
    );
    const match = matchResult.rows[0];
    await insertPlayersAndTeams(client, match.id, players, teams);
    const { players: playerRows, teams: teamRows } = await loadPlayersAndTeams(client, match.id);
    return mapMatchRow(match, playerRows, teamRows);
  });
}

// Edit players/teams - only while in_progress, the same rule matches.service.js enforces.
// Replaces the match's players/teams entirely, inside one transaction (delete + re-insert),
// matching the MongoDB version's own "replace the whole array" semantics.
async function updateMatch(id, { gameMode, players: input }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM app.matches WHERE id = $1 FOR UPDATE", [id]);
    if (current.rows.length === 0) throw new AppError("Match not found", 404);
    const match = current.rows[0];
    if (match.status !== "in_progress") throw stateError(match.number, match.status, "edited");

    const mode = getGameMode(gameMode || match.game_mode);
    const { players, teams } = await resolvePlayers(client, mode, input);

    await client.query("DELETE FROM app.match_players WHERE match_id = $1", [id]);
    await client.query("DELETE FROM app.match_teams WHERE match_id = $1", [id]);
    await insertPlayersAndTeams(client, id, players, teams);

    const updated = await client.query(
      `UPDATE app.matches SET game_mode = $1, updated_by_user_id = $2, updated_by_name = $3, updated_by_username = $4, updated_at = now()
       WHERE id = $5 RETURNING *`,
      [mode.key, userId, actor ? actor.name : null, actor ? actor.username : null, id]
    );
    const { players: playerRows, teams: teamRows } = await loadPlayersAndTeams(client, id);
    return mapMatchRow(updated.rows[0], playerRows, teamRows);
  });
}

// { winnerSeat } for player modes, { winningTeam } for team modes - the same validation
// matches.service.js's own resultFields makes, working out each player's winner/loser result.
async function resultUpdates(client, match, players, { winnerSeat, winningTeam }) {
  const mode = getGameMode(match.game_mode);
  if (mode.resultType === "teams") {
    if (winnerSeat !== undefined && winnerSeat !== null) {
      throw new AppError("For 4 Players, choose the winning team", 400, [{ field: "winningTeam", message: "Choose Team 1 or Team 2" }]);
    }
    const teamsResult = await client.query("SELECT * FROM app.match_teams WHERE match_id = $1", [match.id]);
    const team = teamsResult.rows.find((t) => t.number === winningTeam);
    if (!team) throw new AppError("Choose the winning team: Team 1 or Team 2", 400, [{ field: "winningTeam", message: "Choose Team 1 or Team 2" }]);
    const losing = teamsResult.rows.find((t) => t.number !== winningTeam);
    for (const player of players) {
      await client.query("UPDATE app.match_players SET result = $1 WHERE id = $2", [player.team === team.number ? "winner" : "loser", player.id]);
    }
    return { winningTeam: team.number, losingTeam: losing.number, winnerSeat: null };
  }
  if (winningTeam !== undefined && winningTeam !== null) {
    throw new AppError(`${mode.label} has no teams: choose the player who won`, 400, [{ field: "winnerSeat", message: "Choose the winner" }]);
  }
  if (!players.some((p) => p.seat === winnerSeat)) {
    throw new AppError("Choose the winner from this match's players", 400, [{ field: "winnerSeat", message: "Choose the winner" }]);
  }
  for (const player of players) {
    await client.query("UPDATE app.match_players SET result = $1 WHERE id = $2", [player.seat === winnerSeat ? "winner" : "loser", player.id]);
  }
  return { winnerSeat, winningTeam: null, losingTeam: null };
}

async function completeMatch(id, result, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM app.matches WHERE id = $1 FOR UPDATE", [id]);
    if (current.rows.length === 0) throw new AppError("Match not found", 404);
    const match = current.rows[0];
    if (match.status !== "in_progress") throw stateError(match.number, match.status, "completed");

    const playersResult = await client.query("SELECT * FROM app.match_players WHERE match_id = $1", [id]);
    const fields = await resultUpdates(client, match, playersResult.rows, result);

    const updated = await client.query(
      `UPDATE app.matches
       SET status = 'completed', winner_seat = $1, winning_team = $2, losing_team = $3,
           ended_at = now(), result_recorded_at = now(),
           result_recorded_by_user_id = $4, result_recorded_by_name = $5, result_recorded_by_username = $6,
           updated_by_user_id = $4, updated_by_name = $5, updated_by_username = $6, updated_at = now()
       WHERE id = $7 RETURNING *`,
      [fields.winnerSeat, fields.winningTeam, fields.losingTeam, userId, actor ? actor.name : null, actor ? actor.username : null, id]
    );
    const { players, teams } = await loadPlayersAndTeams(client, id);
    return mapMatchRow(updated.rows[0], players, teams);
  });
}

async function cancelMatch(id, { reason = "" } = {}, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM app.matches WHERE id = $1 FOR UPDATE", [id]);
    if (current.rows.length === 0) throw new AppError("Match not found", 404);
    const match = current.rows[0];
    if (match.status !== "in_progress") throw stateError(match.number, match.status, "cancelled");

    const updated = await client.query(
      `UPDATE app.matches
       SET status = 'cancelled', ended_at = now(), cancelled_at = now(), cancel_reason = $1,
           cancelled_by_user_id = $2, cancelled_by_name = $3, cancelled_by_username = $4,
           updated_by_user_id = $2, updated_by_name = $3, updated_by_username = $4, updated_at = now()
       WHERE id = $5 RETURNING *`,
      [reason, userId, actor ? actor.name : null, actor ? actor.username : null, id]
    );
    const { players, teams } = await loadPlayersAndTeams(client, id);
    return mapMatchRow(updated.rows[0], players, teams);
  });
}

// Plain list, ordered by number - no bill join (explicitly out of scope, see this file's header).
async function listMatchesForSession(sessionId) {
  const session = await query("SELECT id FROM app.sessions WHERE id = $1", [sessionId]);
  if (session.rows.length === 0) throw new AppError("Session not found", 404);
  const matches = await query("SELECT * FROM app.matches WHERE session_id = $1 ORDER BY number ASC", [sessionId]);
  const results = [];
  for (const row of matches.rows) {
    const { players, teams } = await loadPlayersAndTeams({ query: (text, params) => query(text, params) }, row.id);
    results.push(mapMatchRow(row, players, teams));
  }
  return results;
}

module.exports = {
  MATCH_STATUSES, getMatchById, startMatch, updateMatch, completeMatch, cancelMatch,
  listMatchesForSession, mapMatchRow, resolvePlayers,
};
