// A registered player's history (Phase 11.6): their matches, their bills and what they still owe.
//
//   Player -> Match -> Bill -> Payment
//   Player -> Café consumer -> Bill
//
// Everything here is WORKED OUT from the existing records - there are no counters to keep in step:
//  - matches: Match.players.player (the registered player's reference; walk-ins have none)
//  - bills:   Bill.players.player (match bills, Phase 11.5). The player's share and what they have paid
//             are the bill's own players[].shareAmount / paidAmount, which every payment updates
//             atomically (payments.service) - the same numbers the Billing page uses.
//  - outstanding = share - paid on unpaid and partly paid bills; a cancelled bill owes nothing.
// Old bills (whole-session bills, every bill made before Phase 11.5) have free-text names only and are
// never matched to a player by name - so they are not in a player's history.
// Nothing is ever written here.

const { Match } = require("../models/Match");
const { Bill } = require("../models/Bill");
const { getPlayerById } = require("./players.service");

const page = ({ page: number = 1, limit = 10 } = {}) => ({ number, limit, skip: (number - 1) * limit });
const pageInfo = (total, { number, limit }) => ({ total, page: number, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });

// ---------- Matches ----------

// One match from this player's point of view
function matchRow(match, playerId, billByMatch) {
  const me = match.players.find((p) => p.player && String(p.player) === playerId);
  const others = match.players.filter((p) => p !== me);
  const person = (p) => ({ name: p.name, registered: Boolean(p.player), result: p.result ?? null, team: p.team ?? null });
  const isTeam = match.teams && match.teams.length > 0;
  return {
    id: String(match._id),
    number: match.number,
    session: String(match.session),
    tableNumber: match.tableNumber,
    tableName: match.tableName,
    gameMode: match.gameMode,
    status: match.status,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    // The name this player had in the match (a copy - a later rename doesn't change it)
    nameInMatch: me ? me.name : null,
    result: me ? me.result ?? null : null,   // "winner" / "loser" / null (not finished)
    team: me ? me.team ?? null : null,
    winningTeam: match.winningTeam ?? null,
    losingTeam: match.losingTeam ?? null,
    teammates: isTeam && me ? others.filter((p) => p.team === me.team).map(person) : [],
    opponents: isTeam && me ? others.filter((p) => p.team !== me.team).map(person) : others.map(person),
    bill: billByMatch.get(String(match._id)) || null,
  };
}

// ---------- Shared calculations (Phase 11.7: also used by the Players report) ----------
// ONE definition of a player's match statistics and of their bill money, so the player's history
// and the Reports page can never disagree. Both run after a $match on the matches / bills wanted
// and group per "players.player" (the registered player; null = walk-ins).
//   playerCondition: a $match value for "players.player" after $unwind (one player's id, or
//   { $type: "objectId" } for every registered player); null = everyone, walk-ins included.

const EMPTY_MATCH_STATS = Object.freeze({ total: 0, completed: 0, inProgress: 0, cancelled: 0, wins: 0, losses: 0 });

function matchStatsStages(playerCondition = null) {
  return [
    { $unwind: "$players" },
    ...(playerCondition === null ? [] : [{ $match: { "players.player": playerCondition } }]),
    {
      $group: {
        _id: { $ifNull: ["$players.player", null] },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        // Wins and losses: completed matches only
        wins: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $eq: ["$players.result", "winner"] }] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "completed"] }, { $eq: ["$players.result", "loser"] }] }, 1, 0] } },
      },
    },
  ];
}

// Statistics, counted from the matches themselves
async function matchStats(playerObjectId) {
  const [row] = await Match.aggregate([{ $match: { "players.player": playerObjectId } }, ...matchStatsStages(playerObjectId)]);
  const { _id, ...stats } = row || { _id: null, ...EMPTY_MATCH_STATS };
  return stats;
}

async function getPlayerMatches(playerId, options = {}) {
  const player = await getPlayerById(playerId);
  const paging = page(options);
  const filter = { "players.player": player._id };
  const [matches, total, stats] = await Promise.all([
    Match.find(filter).sort({ startedAt: -1, _id: -1 }).skip(paging.skip).limit(paging.limit),
    Match.countDocuments(filter),
    matchStats(player._id),
  ]);
  // Each match's bill, by the bill's own match reference (Phase 11.8: Match.bill is only a pointer)
  const bills = matches.length ? await Bill.find({ match: { $in: matches.map((m) => m._id) } }).select("match billNumber status") : [];
  const billByMatch = new Map(bills.map((b) => [String(b.match), { id: String(b._id), billNumber: b.billNumber, status: b.status }]));
  return {
    player: { id: String(player._id), name: player.name, isActive: player.isActive },
    stats,
    matches: matches.map((m) => matchRow(m, String(player._id), billByMatch)),
    ...pageInfo(total, paging),
  };
}

// ---------- Bills ----------

// What the player owes on one bill: nothing on a cancelled bill, otherwise share - paid (never below 0)
const owedOn = (bill, share) => (bill.status === "cancelled" ? 0 : Math.max(0, share.shareAmount - (share.paidAmount || 0)));

function billRow(bill, playerId) {
  const share = bill.players.find((p) => p.player && String(p.player) === playerId);
  const cafeItems = bill.lineItems.filter((l) => l.type === "cafe" && l.consumerPlayer && String(l.consumerPlayer) === playerId);
  return {
    id: String(bill._id),
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    gameMode: bill.gameMode,
    match: bill.match ? String(bill.match) : null,
    matchNumber: bill.matchNumber ?? null,
    tableNumber: bill.tableNumber,
    tableName: bill.tableName,
    payerRule: bill.payerRule,
    cafePayerRule: bill.cafePayerRule ?? null,
    status: bill.status,
    // The whole bill
    total: bill.total,
    amountPaid: bill.amountPaid,
    balanceDue: bill.status === "cancelled" ? 0 : bill.total - bill.amountPaid,
    // This player's part of it
    share: {
      name: share.name,
      result: share.result ?? null,
      team: share.team ?? null,
      shareAmount: share.shareAmount,
      paidAmount: share.paidAmount || 0,
      outstanding: owedOn(bill, share),
      gameShare: share.gameShare ?? null,
      cafeShare: share.cafeShare ?? null,
    },
    // Café items this player had (consumer pays and the other café rules)
    cafeItems: cafeItems.map((l) => ({ description: l.description, quantity: l.quantity, amount: l.amount })),
  };
}

// A player's money on bills: their OWN entry on each bill (shareAmount / paidAmount), never the
// whole bill and never a team-mate's part. Cancelled bills owe nothing and add no money.
const EMPTY_BILL_SUMMARY = Object.freeze({ bills: 0, cancelledBills: 0, openBills: 0, totalShare: 0, totalPaid: 0, outstanding: 0 });

function billSummaryStages(playerCondition = null) {
  return [
    { $unwind: "$players" },
    ...(playerCondition === null ? [] : [{ $match: { "players.player": playerCondition } }]),
    {
      $project: {
        player: { $ifNull: ["$players.player", null] },
        status: 1,
        share: "$players.shareAmount",
        paid: { $ifNull: ["$players.paidAmount", 0] },
        open: { $in: ["$status", ["unpaid", "partially_paid"]] },
        cancelled: { $eq: ["$status", "cancelled"] },
      },
    },
    {
      $group: {
        _id: "$player",
        bills: { $sum: { $cond: ["$cancelled", 0, 1] } },
        cancelledBills: { $sum: { $cond: ["$cancelled", 1, 0] } },
        openBills: { $sum: { $cond: [{ $and: ["$open", { $gt: [{ $subtract: ["$share", "$paid"] }, 0] }] }, 1, 0] } },
        totalShare: { $sum: { $cond: ["$cancelled", 0, "$share"] } },
        totalPaid: { $sum: { $cond: ["$cancelled", 0, "$paid"] } },
        outstanding: { $sum: { $cond: ["$open", { $max: [0, { $subtract: ["$share", "$paid"] }] }, 0] } },
      },
    },
  ];
}

// Totals over ALL of the player's bills (not just one page)
async function billSummary(playerObjectId) {
  const [row] = await Bill.aggregate([{ $match: { "players.player": playerObjectId } }, ...billSummaryStages(playerObjectId)]);
  const { _id, ...summary } = row || { _id: null, ...EMPTY_BILL_SUMMARY };
  return summary;
}

async function getPlayerBills(playerId, options = {}) {
  const player = await getPlayerById(playerId);
  const paging = page(options);
  const filter = { "players.player": player._id };
  if (options.status === "open") filter.status = { $in: ["unpaid", "partially_paid"] };
  else if (options.status) filter.status = options.status;
  const [bills, total, summary] = await Promise.all([
    Bill.find(filter).sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.limit),
    Bill.countDocuments(filter),
    billSummary(player._id),
  ]);
  return {
    player: { id: String(player._id), name: player.name, isActive: player.isActive },
    summary,
    bills: bills.map((b) => billRow(b, String(player._id))),
    ...pageInfo(total, paging),
  };
}

module.exports = {
  getPlayerMatches, getPlayerBills,
  // Phase 11.7: the same calculations for the Players report
  matchStatsStages, billSummaryStages, EMPTY_MATCH_STATS, EMPTY_BILL_SUMMARY,
};
