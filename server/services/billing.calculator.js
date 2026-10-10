// The billing maths. These are "pure" functions: numbers in, numbers out - no database,
// no HTTP. That makes them easy to test and impossible to "accidentally" change a bill.
// All money is in whole paisa (Rs 150.00 = 15000), so there are no rounding errors.

const { GAME_MODES, gameLineDescription } = require("../config/gameModes");

// Labels by key ({ century: "Century", frame: "Frame", ... }) - from the central registry
const GAME_LABELS = Object.freeze(Object.fromEntries(GAME_MODES.map((mode) => [mode.key, mode.label])));

// The bill line text ("Century game", "Century games", "Frame", "Frames") comes from the registry too.

// ---------- Time rule ----------
// Minimum charge of `minimumMinutes`, then round UP to the next `incrementMinutes`.
// With the club defaults (15 and 5):  1-15 min -> 15,  16-20 -> 20,  21-25 -> 25,  15m01s -> 20
function billableMinutes(durationSeconds, minimumMinutes = 15, incrementMinutes = 5) {
  const seconds = Math.max(0, Math.floor(durationSeconds || 0));
  const playedMinutes = Math.ceil(seconds / 60); // a started minute counts as a full minute
  const step = Math.max(1, incrementMinutes);
  const rounded = Math.ceil(playedMinutes / step) * step;
  return Math.max(minimumMinutes, rounded);
}

// ---------- Tax ----------
// Rate in "basis points": 1600 = 16.00%. Rounded half-up to whole paisa.
// While tax is disabled the result is always 0.
function calculateTax(subtotal, taxEnabled, taxRateBasisPoints) {
  if (!taxEnabled || taxRateBasisPoints <= 0) return 0;
  return Math.floor((subtotal * taxRateBasisPoints + 5000) / 10000);
}

// ---------- Who pays ----------
// loser  -> the player(s) marked "loser" pay everything
// winner -> the player(s) marked "winner" pay everything
// split  -> ("Both Pay") everyone pays an equal part
// When several players pay (e.g. the two losers of a 4 Players match, Phase 11.5) they pay equal
// parts. Paisa that can't be divided evenly go to the first payers one by one, so the parts always
// add up to exactly the total. With ONE loser/winner (every bill made in the Create Bill window)
// that player pays everything, exactly as before.
function splitShares(total, players, payerRule) {
  const pays = payerRule === "loser" || payerRule === "winner"
    ? players.map((player) => player.result === payerRule)
    : players.map(() => true);
  const count = pays.filter(Boolean).length;
  if (count === 0) return players.map(() => 0);
  const base = Math.floor(total / count);
  let leftover = total - base * count;
  return pays.map((payer) => {
    if (!payer) return 0;
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    return base + extra;
  });
}

// ---------- Café payer rule (Phase 10) ----------
// Splits the café part (café items + their part of the tax) between the players:
//   loser    -> the player marked "loser" pays all café items
//   split    -> everyone pays an equal part (same rounding as splitShares)
//   consumer -> each player pays for the items they had. The café tax is shared in proportion
//               to what each one had; leftover paisa go to the first consumers, one each.
function splitCafeShares(cafeTotal, cafeTax, cafeLines, players, cafePayerRule) {
  const amount = cafeTotal + cafeTax;
  if (cafePayerRule === "loser") return splitShares(amount, players, "loser"); // several losers: equal parts
  if (cafePayerRule === "split") return splitShares(amount, players, "split");

  // consumer: line.consumer is a player's name (checked before calculating)
  const own = players.map((player) => cafeLines
    .filter((line) => line.consumer === player.name)
    .reduce((sum, line) => sum + line.amount, 0));
  const taxParts = own.map((value) => (cafeTotal > 0 ? Math.floor((cafeTax * value) / cafeTotal) : 0));
  let leftover = cafeTax - taxParts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < players.length && leftover > 0; i += 1) {
    if (own[i] > 0) {
      taxParts[i] += 1;
      leftover -= 1;
    }
  }
  return own.map((value, i) => value + taxParts[i]);
}

// ---------- Whole bill ----------
// gameMode = a registry key (config/gameModes.js), quantity = number of games/frames, unitPrice = rate snapshot.
// pricingType (Phase 11.3):
//   "per_minute" -> the game line is billedMinutes × unitPrice ("Century minutes × 50 @ Rs 10.00")
//   anything else, or not given -> quantity × unitPrice, exactly as before
// cafeItems: [{ description, quantity, unitPrice, product?, categoryName?, consumer?, cafeOrder? }] (all paisa)
//
// cafePayerRule (Phase 10):
//   not given -> EXACTLY the old behaviour: the whole total (game + café + tax) is split by payerRule.
//   given     -> the game part is split by payerRule and the café part by cafePayerRule.
//                The tax is the same single tax on the subtotal; its game part is the tax the game
//                alone would have, the café gets the rest - so the parts always add up to the total.
function calculateBill({ gameMode, quantity, unitPrice, pricingType = null, billedMinutes = null, cafeItems = [], taxEnabled = false, taxRateBasisPoints = 0,
                         payerRule, players, cafePayerRule = null }) {
  const lineQuantity = pricingType === "per_minute" ? billedMinutes : quantity;
  if (!Number.isInteger(lineQuantity) || lineQuantity < 1) throw new Error("calculateBill: the game line needs a whole quantity of at least 1");
  const gameLine = {
    type: "game",
    description: gameLineDescription(gameMode, lineQuantity, pricingType),
    quantity: lineQuantity,
    unitPrice,
    amount: lineQuantity * unitPrice,
  };
  const cafeLines = cafeItems.map((item) => {
    const line = {
      type: "cafe",
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: item.quantity * item.unitPrice,
    };
    // Extra details only exist on Phase 10 bills (older bills keep their exact old shape)
    for (const key of ["product", "categoryName", "consumer", "consumerPlayer", "cafeOrder"]) {
      if (item[key] !== undefined && item[key] !== null && item[key] !== "") line[key] = item[key];
    }
    return line;
  });
  const lineItems = [gameLine, ...cafeLines];

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const taxAmount = calculateTax(subtotal, taxEnabled, taxRateBasisPoints);
  const total = subtotal + taxAmount;
  const result = {
    lineItems,
    subtotal,
    taxEnabled: Boolean(taxEnabled),
    taxRateBasisPoints: taxEnabled ? taxRateBasisPoints : 0,
    taxAmount,
    total,
  };

  if (!cafePayerRule) {
    // Unchanged pre-Phase-10 calculation
    const shares = splitShares(total, players, payerRule);
    result.players = players.map((player, index) => ({
      name: player.name,
      result: player.result || null,
      shareAmount: shares[index],
    }));
    return result;
  }

  const cafeTotal = cafeLines.reduce((sum, line) => sum + line.amount, 0);
  const gameTax = calculateTax(gameLine.amount, taxEnabled, taxRateBasisPoints);
  const cafeTax = taxAmount - gameTax;
  const cafeShares = splitCafeShares(cafeTotal, cafeTax, cafeLines, players, cafePayerRule);
  let shares;
  if (payerRule === "split" && cafePayerRule === "split") {
    // Everyone splits everything: split the WHOLE total at once, exactly as before Phase 10
    // (fairer rounding than splitting the game and the café separately)
    shares = splitShares(total, players, "split");
  } else {
    const gameShares = splitShares(gameLine.amount + gameTax, players, payerRule);
    shares = gameShares.map((game, index) => game + cafeShares[index]);
  }
  result.cafePayerRule = cafePayerRule;
  result.players = players.map((player, index) => ({
    name: player.name,
    result: player.result || null,
    shareAmount: shares[index],
    gameShare: shares[index] - cafeShares[index],
    cafeShare: cafeShares[index],
  }));
  return result;
}

module.exports = { billableMinutes, calculateTax, splitShares, splitCafeShares, calculateBill, GAME_LABELS };
