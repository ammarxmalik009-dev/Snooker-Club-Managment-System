// Business rules for bills: preview, create, list, view and cancel.
// The amount is ALWAYS calculated here on the server (billing.calculator.js),
// never taken from the browser.

const mongoose = require("mongoose");
const { Bill } = require("../models/Bill");
const { Match } = require("../models/Match");
const { Payment } = require("../models/Payment");
const { Session } = require("../models/Session");
const { nextSequence } = require("../models/Counter");
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { formatMoney } = require("../utils/money");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, dateInTimeZone } = require("../utils/time");
const { billableMinutes, calculateBill, GAME_LABELS } = require("./billing.calculator");
const { rateFromSettings, getGameMode } = require("../config/gameModes");
const { getSettings } = require("./settings.service");
const { actorFrom } = require("../models/schemas/actor");
const { Product } = require("../models/Product");
const { Category } = require("../models/Category");
const stockService = require("./stock.service");
const cafeOrdersService = require("./cafeOrders.service");
const matchesService = require("./matches.service");

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Shared checks + calculation (used by preview AND create) ----------

async function loadBillableSession(sessionId) {
  const session = await Session.findById(sessionId);
  if (!session) throw new AppError("Session not found", 404);
  if (session.isOpen) {
    throw new AppError(`The session on Table ${session.tableNumber} is still running. End it before billing.`, 409);
  }
  const existing = await Bill.findOne({ session: session._id, match: null }).select("billNumber");
  if (existing) {
    throw new AppError(`This session already has bill ${existing.billNumber}`, 409);
  }
  // Phase 11.5: a session played as matches is billed match by match. A bill for the whole
  // session on top would charge the same games twice.
  if (await Match.exists({ session: session._id, status: { $ne: "cancelled" } })) {
    throw new AppError(`The session on Table ${session.tableNumber} has matches. Bill each completed match from the Matches window.`, 409);
  }
  return session;
}

// ---------- Café lines (Phase 10) ----------
// The café part of a bill = every OPEN item on the session's tab + the items added in the
// Create Bill window (a product from the list, or a typed-in one-off item).
// Names, prices and category names are copied into the bill, so later changes never alter it.
// Returns the lines, the stock each counted product needs, and the tab item ids.

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// options (Phase 11.5, match bills): includeTab false = leave the session's tab open for a later
// bill; singleLoser false = "the loser pays the café" may mean several losers (equal parts).
async function resolveCafe(session, input, { includeTab = true, singleLoser = true } = {}) {
  const players = input.players;
  const playerFor = (name) => players.find((p) => sameName(p.name, name));
  const tabOrders = includeTab ? await cafeOrdersService.openItemsForSession(session._id) : [];
  const overrides = new Map((input.tabItems || []).map((t) => [String(t.id), t.consumer]));
  for (const id of overrides.keys()) {
    if (!tabOrders.some((order) => String(order._id) === id)) {
      throw new AppError("The session's café tab has changed. Close and open the bill window again.", 409);
    }
  }

  const windowProductIds = (input.cafeItems || []).filter((item) => item.productId).map((item) => item.productId);
  const tabProductIds = tabOrders.filter((order) => order.product).map((order) => order.product);
  const products = await Product.find({ _id: { $in: [...windowProductIds, ...tabProductIds] } });
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const categories = await Category.find({ _id: { $in: products.map((p) => p.category) } });
  const categoryName = (product) => (categories.find((c) => String(c._id) === String(product.category)) || {}).name || "";

  const lines = tabOrders.map((order) => ({
    description: order.description,
    quantity: order.quantity,
    unitPrice: order.unitPrice, // the price when it was ordered
    product: order.product || undefined,
    categoryName: order.categoryName || undefined,
    consumer: overrides.has(String(order._id)) ? overrides.get(String(order._id)) : order.consumer,
    cafeOrder: order._id,
  }));
  for (const item of input.cafeItems || []) {
    if (item.productId) {
      const product = productById.get(String(item.productId));
      if (!product) throw new AppError("A café product on this bill no longer exists", 400, [{ field: "cafeItems", message: "Choose a product from the list" }]);
      if (product.status !== "active") throw new AppError(`${product.name} is not on sale (inactive)`, 409, [{ field: "cafeItems", message: `${product.name} is inactive` }]);
      lines.push({
        description: product.name.slice(0, 60), quantity: item.quantity, unitPrice: product.price, // today's price
        product: product._id, categoryName: categoryName(product) || undefined, consumer: item.consumer,
      });
    } else {
      lines.push({ description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, consumer: item.consumer });
    }
  }

  // "Who had it": always one of this bill's players (spelled as on the bill), or nobody
  const cafePayerRule = lines.length > 0 && input.cafePayerRule ? input.cafePayerRule : null;
  const missing = [];
  for (const line of lines) {
    const player = line.consumer ? playerFor(line.consumer) : null;
    if (line.consumer && !player && cafePayerRule === "consumer") missing.push(`${line.description} (${line.consumer} is not a player on this bill)`);
    else if (!player && cafePayerRule === "consumer") missing.push(line.description);
    line.consumer = player ? player.name : undefined;
    // Match bills: a registered player keeps their reference too (walk-ins: the name only)
    line.consumerPlayer = player && player.player ? player.player : undefined;
  }
  if (missing.length) {
    throw new AppError(`Consumer pays: choose which player had ${missing.join(", ")}`, 400, [{ field: "cafePayerRule", message: "Every café item needs a player" }]);
  }
  const losers = players.filter((p) => p.result === "loser").length;
  if (cafePayerRule === "loser" && (singleLoser ? losers !== 1 : losers === 0)) {
    throw new AppError("Choose the one player who lost (the loser pays for the café)", 400, [{ field: "cafePayerRule", message: "Mark the loser" }]);
  }

  // Stock needed, per product that counts stock
  const stockNeeds = new Map();
  for (const line of lines) {
    const product = line.product && productById.get(String(line.product));
    if (product && product.trackStock) stockNeeds.set(String(product._id), (stockNeeds.get(String(product._id)) || 0) + line.quantity);
  }
  // Early, friendly check (the real, atomic check happens when the bill is created)
  for (const [id, quantity] of stockNeeds) {
    const product = productById.get(id);
    if (product.stockQuantity < quantity) {
      throw new AppError(`Not enough stock: ${product.name} has ${product.stockQuantity} left, this bill needs ${quantity}`, 409,
        [{ field: "cafeItems", message: `${product.name}: only ${product.stockQuantity} left` }]);
    }
  }
  return { lines, cafePayerRule, stockNeeds, tabIds: tabOrders.map((order) => order._id) };
}

// Rate snapshot: the rate from the club rate list RIGHT NOW is copied into the bill, with how
// it is applied (registry pricingType). Old bills are never recalculated. Rs 0 = switched off.
function currentRate(gameMode, settings) {
  const unitPrice = rateFromSettings(gameMode, settings);
  if (unitPrice === null || unitPrice <= 0) {
    const label = GAME_LABELS[gameMode].toLowerCase();
    throw new AppError(`Set the ${label} price in Settings before creating ${label} bills`, 409, [
      { field: "gameMode", message: `The ${label} price is not set yet` },
    ]);
  }
  return { unitPrice, pricingType: getGameMode(gameMode).pricingType };
}

// Time rule (15 min minimum, 5 min steps) - recorded on every bill; Century is charged by it.
// The SAME function and settings as always: there is only one billing-time rule, and the
// SESSION is the clock (a match has no timer of its own).
const sessionBilledMinutes = (session, settings) =>
  billableMinutes(session.durationSeconds, settings.minimumBillableMinutes, settings.billingIncrementMinutes);

async function prepareBill(sessionId, input) {
  const session = await loadBillableSession(sessionId);
  const settings = await getSettings();
  const cafe = await resolveCafe(session, input);
  const { unitPrice, pricingType } = currentRate(input.gameMode, settings);
  const billedMinutes = sessionBilledMinutes(session, settings);

  const calculation = calculateBill({
    gameMode: input.gameMode,
    quantity: input.quantity,
    unitPrice,
    pricingType,
    billedMinutes,
    cafeItems: cafe.lines,
    taxEnabled: settings.taxEnabled,
    taxRateBasisPoints: settings.taxRateBasisPoints,
    payerRule: input.payerRule,
    players: input.players,
    cafePayerRule: cafe.cafePayerRule,
  });

  const data = {
    session: session._id,
    table: session.table,
    tableNumber: session.tableNumber,
    tableName: session.tableName,
    sessionStartedAt: session.startedAt,
    sessionEndedAt: session.endedAt,
    durationSeconds: session.durationSeconds,
    billedMinutes,
    gameMode: input.gameMode,
    quantity: input.quantity,
    unitPrice,
    pricingType,
    payerRule: input.payerRule,
    ...calculation,
  };
  return { data, stockNeeds: cafe.stockNeeds, tabIds: cafe.tabIds };
}

// ---------- Preview & create ----------

// Same numbers as a real bill, but nothing is saved (the page shows this while you type)
async function previewBill(input) {
  const { data, tabIds } = await prepareBill(input.sessionId, input);
  return { ...data, balanceDue: data.total, tabItemCount: tabIds.length };
}

async function createBill(input, actorUser = null) {
  const { data, stockNeeds, tabIds } = await prepareBill(input.sessionId, input);
  return saveBill(data, stockNeeds, tabIds, actorUser, () => new AppError("This session already has a bill", 409));
}

// Saving a bill (both paths): take the café stock, number the bill, insert it, then mark the tab
// items and record the sale. If the insert fails the stock goes back, so nothing is half done.
// duplicateError(error) -> the 409 to give when a unique index refuses the bill.
async function saveBill(data, stockNeeds, tabIds, actorUser, duplicateError) {
  const billId = new mongoose.Types.ObjectId();

  // Phase 11.5: a session can now have several bills (one per match), so the tab items are claimed
  // for THIS bill first, atomically. If another bill took any of them meanwhile, nothing is billed.
  const claimed = await cafeOrdersService.claimForBill(tabIds, billId);
  if (claimed !== tabIds.length) {
    await cafeOrdersService.releaseClaim(billId);
    throw new AppError("The session's café tab changed while this bill was being made. Close the bill window and open it again.", 409);
  }

  let taken;
  try {
    // Phase 10: take the café stock - all or nothing, atomic per product (never below 0)
    taken = await stockService.takeForBill(stockNeeds);
  } catch (error) {
    await cafeOrdersService.releaseClaim(billId);
    throw error;
  }

  // Bill number: B-<club date>-<number of the day>, e.g. B-20261005-0007
  const day = dateInTimeZone(new Date(), env.clubTimeZone);
  const sequence = await nextSequence(`bill-${day}`);
  const billNumber = `B-${day.replace(/-/g, "")}-${String(sequence).padStart(4, "0")}`;

  let bill;
  try {
    bill = await Bill.create({ _id: billId, ...data, billNumber, createdBy: actorFrom(actorUser) });
  } catch (error) {
    // The bill wasn't saved: the stock wasn't sold and the tab items are open again
    await stockService.putBack(taken);
    await cafeOrdersService.releaseClaim(billId);
    // Two people billing the same session / match at the same moment: a unique index stops the second
    if (error.code === 11000 && error.keyPattern && error.keyPattern.session) throw duplicateError(error);
    throw error;
  }

  await stockService.recordSale(taken, bill, actorUser); // stock history linked to the bill
  return bill;
}

// ---------- Match bills (Phase 11.5) ----------
// Session -> Match -> Bill -> Payment. One bill per COMPLETED match; a session with matches has
// one bill per match. The game type, players and result come from the match and can't be changed
// here; the rate is today's rate (copied into the bill); the time is the session's billed time.

const STATUS_WORDS = { in_progress: "still in progress", cancelled: "cancelled" };

async function loadBillableMatch(matchId) {
  const match = await Match.findById(matchId);
  if (!match) throw new AppError("Match not found", 404);
  if (match.status !== "completed") {
    throw new AppError(`Match #${match.number} must be completed before it can be billed (it is ${STATUS_WORDS[match.status]}).`, 409);
  }
  // One bill per match (also a unique index). The bill's own `match` reference decides - and if the
  // match lost its pointer to it (Phase 11.8), the pointer is repaired; no second bill is ever made.
  const existing = await Bill.findOne({ match: match._id }).select("billNumber");
  if (existing) {
    if (!match.bill) await matchesService.repairBillPointer(match._id, existing._id);
    throw new AppError(`Match #${match.number} already has bill ${existing.billNumber}`, 409);
  }

  const session = await Session.findById(match.session);
  if (!session) throw new AppError(`The session of match #${match.number} no longer exists`, 409);
  if (session.isOpen) {
    // The session is the clock: its time is only known once it has ended
    throw new AppError(`The session on Table ${session.tableNumber} is still running. End it before billing its matches.`, 409);
  }
  const sessionBill = await Bill.findOne({ session: session._id, match: null, status: { $ne: "cancelled" } }).select("billNumber");
  if (sessionBill) {
    throw new AppError(`This session was billed as a whole (bill ${sessionBill.billNumber}), so its matches can't be billed separately.`, 409);
  }
  return { match, session };
}

// Phase 11.8: could ANOTHER match of this session still get a bill (and so take the café tab later)?
// Yes for a completed match without a bill, or one still in progress (it can be completed after the
// session ended) - unless it could never be billed:
//  - a Century match once the session's time is charged (by this Century bill or an earlier one -
//    cancelled Century bills included: the database keeps them, Phase 11.5 rule);
//  - a game type whose rate is Rs 0 (switched off).
async function anotherBillableMatch(match, session, pricingType) {
  const others = await Match.find({ session: session._id, _id: { $ne: match._id }, status: { $in: ["in_progress", "completed"] } }).select("gameMode");
  if (others.length === 0) return false;
  const billed = new Set((await Bill.find({ session: session._id, match: { $in: others.map((m) => m._id) } }).select("match")).map((b) => String(b.match)));
  const settings = await getSettings();
  const centuryTaken = pricingType === "per_minute"
    || Boolean(await Bill.exists({ session: session._id, pricingType: "per_minute", match: { $type: "objectId" } }));
  return others.some((other) => {
    if (billed.has(String(other._id))) return false;
    const rate = rateFromSettings(other.gameMode, settings);
    if (rate === null || rate <= 0) return false;
    return !(getGameMode(other.gameMode).pricingType === "per_minute" && centuryTaken);
  });
}

async function prepareMatchBill(matchId, input) {
  const { match, session } = await loadBillableMatch(matchId);
  const settings = await getSettings();
  const mode = getGameMode(match.gameMode);
  const { unitPrice, pricingType } = currentRate(match.gameMode, settings);

  if (pricingType === "per_minute") {
    const timeBill = await Bill.findOne({ session: session._id, pricingType: "per_minute", match: { $type: "objectId" } }).select("billNumber matchNumber");
    if (timeBill) {
      throw new AppError(`This session's time was already charged on bill ${timeBill.billNumber} (Century match #${timeBill.matchNumber}). Century is charged by the session's time, so a session can have only one Century bill.`, 409);
    }
  }

  // Phase 11.8: the café tab can be left for a LATER match bill only if one can still be made.
  // On the session's last billable match, open tab items must go on this bill - otherwise they would
  // never be billed and would keep holding stock. (Checked here, so the server enforces it.)
  const openTabItems = (await cafeOrdersService.openItemsForSession(session._id)).length;
  const cafeTabMustStay = openTabItems > 0 && !(await anotherBillableMatch(match, session, pricingType));
  if (input.includeCafeTab === false && cafeTabMustStay) {
    throw new AppError(`This is the last match of the session that can be billed, so the session's café tab (${openTabItems} item${openTabItems === 1 ? "" : "s"}) must go on this bill.`, 409,
      [{ field: "includeCafeTab", message: "The café tab must go on this bill" }]);
  }

  // The bill's players = the match's players, with their result (copies, plus the registered player)
  const players = match.players.map((p) => ({ name: p.name, result: p.result, player: p.player || undefined, team: p.team ?? undefined }));
  const cafe = await resolveCafe(session, { ...input, players }, { includeTab: input.includeCafeTab !== false, singleLoser: false });
  const billedMinutes = sessionBilledMinutes(session, settings);

  const calculation = calculateBill({
    gameMode: match.gameMode,
    quantity: 1, // one match = one game / one frame (another frame is another match)
    unitPrice,
    pricingType,
    billedMinutes,
    cafeItems: cafe.lines,
    taxEnabled: settings.taxEnabled,
    taxRateBasisPoints: settings.taxRateBasisPoints,
    payerRule: input.payerRule,
    players,
    cafePayerRule: cafe.cafePayerRule,
  });
  // The calculator keeps the order of the players: add their registered player and team back
  calculation.players = calculation.players.map((share, i) => ({
    ...share,
    ...(players[i].player ? { player: players[i].player } : {}),
    ...(players[i].team ? { team: players[i].team } : {}),
  }));

  const data = {
    session: session._id,
    table: session.table,
    tableNumber: session.tableNumber,
    tableName: session.tableName,
    sessionStartedAt: session.startedAt,
    sessionEndedAt: session.endedAt,
    durationSeconds: session.durationSeconds,
    billedMinutes,
    gameMode: match.gameMode,
    quantity: 1,
    unitPrice,
    pricingType,
    payerRule: input.payerRule,
    match: match._id,
    matchNumber: match.number,
    ...(mode.resultType === "teams" ? { winningTeam: match.winningTeam, losingTeam: match.losingTeam } : {}),
    ...calculation,
  };
  return { data, match, stockNeeds: cafe.stockNeeds, tabIds: cafe.tabIds, cafeTabMustStay };
}

// cafeTabMustStay (Phase 11.8): true = this is the last chance to bill the session's open café tab,
// so the bill window keeps "Put the café tab on this bill" ticked and explains why
async function previewMatchBill(matchId, input) {
  const { data, tabIds, cafeTabMustStay } = await prepareMatchBill(matchId, input);
  return { ...data, balanceDue: data.total, tabItemCount: tabIds.length, cafeTabMustStay };
}

async function createMatchBill(matchId, input, actorUser = null) {
  const { data, match, stockNeeds, tabIds } = await prepareMatchBill(matchId, input);
  const bill = await saveBill(data, stockNeeds, tabIds, actorUser, (error) => {
    // Which unique index refused it: this match already billed, or a second Century time bill
    if (String(error.message).includes("one_century_time_bill_per_session")) {
      return new AppError("This session's time was just charged on another Century bill. A session can have only one Century bill.", 409);
    }
    return new AppError(`Match #${match.number} already has a bill`, 409);
  });
  // The match points to its bill too (the bill's unique index is what guarantees "one bill per match")
  await Match.updateOne({ _id: match._id }, { $set: { bill: bill._id } });
  return bill;
}

async function getMatchBill(matchId) {
  const match = await Match.findById(matchId).select("number");
  if (!match) throw new AppError("Match not found", 404);
  const bill = await Bill.findOne({ match: match._id });
  if (!bill) throw new AppError(`Match #${match.number} has no bill yet`, 404);
  return getBillWithPayments(bill._id);
}

// ---------- Read ----------

async function listBills({ status, from, to, search, page = 1, limit = 25 } = {}) {
  const filter = {};
  // "open" = everything still to collect (unpaid + partially paid)
  if (status === "open") filter.status = { $in: ["unpaid", "partially_paid"] };
  else if (status) filter.status = status;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfDayInTimeZone(from, env.clubTimeZone);
    if (to) filter.createdAt.$lt = startOfNextDayInTimeZone(to, env.clubTimeZone);
  }

  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    const conditions = [{ billNumber: pattern }, { tableName: pattern }, { "players.name": pattern }];
    if (/^\d+$/.test(search)) conditions.push({ tableNumber: Number(search) });
    filter.$or = conditions;
  }

  const [bills, total] = await Promise.all([
    Bill.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Bill.countDocuments(filter),
  ]);
  return { bills, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getBillWithPayments(id) {
  const bill = await Bill.findById(id);
  if (!bill) throw new AppError("Bill not found", 404);
  const payments = await Payment.find({ bill: bill._id }).sort({ paidAt: 1 });
  return { ...bill.toJSON(), payments };
}

// The bill made for each WHOLE session (session history page, dashboard) - match bills are not
// included: a session played as matches has one bill per match (see matches summary).
// withDetails: also include the game type, number of games/frames and billed time.
async function getBillsForSessions(sessionIds, { withDetails = false } = {}) {
  const bills = await Bill.find({ session: { $in: sessionIds }, match: null })
    .select("session billNumber status total amountPaid gameMode quantity billedMinutes");
  return new Map(
    bills.map((bill) => {
      const info = { id: String(bill._id), billNumber: bill.billNumber, status: bill.status, total: bill.total, amountPaid: bill.amountPaid };
      if (withDetails) Object.assign(info, { gameMode: bill.gameMode, quantity: bill.quantity, billedMinutes: bill.billedMinutes });
      return [String(bill.session), info];
    })
  );
}

// ---------- Cancel ----------

// Only bills without any payment can be cancelled (refunds come in a later phase)
async function cancelBill(id, reason = "", actorUser = null) {
  const cancelled = await Bill.findOneAndUpdate(
    { _id: id, status: "unpaid", amountPaid: 0 },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason, cancelledBy: actorFrom(actorUser) } },
    { returnDocument: "after", runValidators: true }
  );
  if (cancelled) {
    // Phase 10: nothing was paid, so the café items weren't sold - their stock goes back.
    // This runs once: only one request can change the status to "cancelled".
    await stockService.restoreForCancelledBill(cancelled, actorUser);
    return cancelled;
  }

  const bill = await Bill.findById(id);
  if (!bill) throw new AppError("Bill not found", 404);
  if (bill.status === "cancelled") throw new AppError(`Bill ${bill.billNumber} is already cancelled`, 409);
  throw new AppError(
    `Bill ${bill.billNumber} already has payments of ${formatMoney(bill.amountPaid)}, so it can't be cancelled (refunds are not supported yet)`,
    409
  );
}

module.exports = {
  previewBill, createBill, listBills, getBillWithPayments, getBillsForSessions, cancelBill,
  previewMatchBill, createMatchBill, getMatchBill,
};
