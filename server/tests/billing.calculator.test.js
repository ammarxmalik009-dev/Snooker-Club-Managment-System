// Tests for server/services/billing.calculator.js - the billing maths.

const test = require("node:test");
const assert = require("node:assert/strict");
const { billableMinutes, calculateTax, splitShares, calculateBill } = require("../services/billing.calculator");

const minutes = (m, s = 0) => m * 60 + s;

test("time rule: 15 min minimum, then round UP to the next 5 minutes", () => {
  const cases = [
    [0, 15], [minutes(0, 30), 15], [minutes(1), 15], [minutes(15), 15], // 1-15 -> 15
    [minutes(15, 1), 20], [minutes(16), 20], [minutes(20), 20],         // 16-20 -> 20
    [minutes(21), 25], [minutes(25), 25],                               // 21-25 -> 25
    [minutes(26), 30], [minutes(30), 30],                               // 26-30 -> 30
    [minutes(31), 35], [minutes(35), 35],                               // 31-35 -> 35
    [minutes(47), 50], [minutes(60), 60], [minutes(61), 65], [minutes(119, 59), 120],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(billableMinutes(seconds, 15, 5), expected, `${seconds}s should bill ${expected} min`);
  }
});

test("time rule settings are configurable", () => {
  assert.equal(billableMinutes(minutes(47), 30, 15), 60);
  assert.equal(billableMinutes(minutes(10), 30, 15), 30);
  assert.equal(billableMinutes(minutes(47, 10), 1, 1), 48);
});

test("tax: 0 while disabled; half-up rounding when enabled", () => {
  assert.equal(calculateTax(50000, false, 1600), 0);
  assert.equal(calculateTax(50000, true, 0), 0);
  assert.equal(calculateTax(50000, true, 1600), 8000);  // 16% of Rs 500 = Rs 80
  assert.equal(calculateTax(15003, true, 1600), 2400);  // 2400.48 -> 2400
  assert.equal(calculateTax(15003, true, 1650), 2475);  // 2475.495 -> 2475
  assert.equal(calculateTax(15004, true, 1650), 2476);  // 2475.66 -> 2476
});

const two = [{ name: "Ali", result: "winner" }, { name: "Usman", result: "loser" }];

test("who pays: loser, winner, split (shares always add up to the total)", () => {
  assert.deepEqual(splitShares(30000, two, "loser"), [0, 30000]);
  assert.deepEqual(splitShares(30000, two, "winner"), [30000, 0]);
  assert.deepEqual(splitShares(30000, two, "split"), [15000, 15000]);
  assert.deepEqual(splitShares(30001, two, "split"), [15001, 15000]);
  const four = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }];
  assert.deepEqual(splitShares(10003, four, "split"), [2501, 2501, 2501, 2500]);
  const three = four.slice(0, 3);
  assert.deepEqual(splitShares(10000, three, "split"), [3334, 3333, 3333]);
  for (const total of [1, 99, 10001, 33333]) {
    assert.equal(splitShares(total, three, "split").reduce((a, b) => a + b, 0), total);
  }
});

test("century bill: games x fixed price, loser pays", () => {
  const bill = calculateBill({ gameMode: "century", quantity: 3, unitPrice: 30000, payerRule: "loser", players: two });
  assert.deepEqual(bill.lineItems, [{ type: "game", description: "Century games", quantity: 3, unitPrice: 30000, amount: 90000 }]);
  assert.equal(bill.subtotal, 90000);
  assert.equal(bill.taxAmount, 0);
  assert.equal(bill.taxEnabled, false);
  assert.equal(bill.total, 90000);
  assert.deepEqual(bill.players.map((p) => p.shareAmount), [0, 90000]);
});

test("frame bill with café items, split between 3 players", () => {
  const bill = calculateBill({
    gameMode: "frame", quantity: 1, unitPrice: 15000, payerRule: "split",
    players: [{ name: "A" }, { name: "B" }, { name: "C" }],
    cafeItems: [{ description: "Tea", quantity: 3, unitPrice: 8000 }, { description: "Water", quantity: 1, unitPrice: 6050 }],
  });
  assert.equal(bill.lineItems[0].description, "Frame");
  assert.deepEqual(bill.lineItems.map((l) => l.amount), [15000, 24000, 6050]);
  assert.equal(bill.subtotal, 45050);
  assert.equal(bill.total, 45050);
  assert.deepEqual(bill.players.map((p) => p.shareAmount), [15017, 15017, 15016]);
});

test("tax enabled: added on top of the subtotal and stored on the bill", () => {
  const bill = calculateBill({ gameMode: "frame", quantity: 4, unitPrice: 15000, payerRule: "winner", players: two,
                               taxEnabled: true, taxRateBasisPoints: 1600 });
  assert.equal(bill.lineItems[0].description, "Frames");
  assert.equal(bill.subtotal, 60000);
  assert.equal(bill.taxAmount, 9600);
  assert.equal(bill.total, 69600);
  assert.equal(bill.taxRateBasisPoints, 1600);
  assert.deepEqual(bill.players.map((p) => p.shareAmount), [69600, 0]);
});
