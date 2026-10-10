// Automatic tests for Phase 10: café categories, products, stock, session tabs and café billing.
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const { calculateBill, splitCafeShares } = require("../services/billing.calculator");

const TEST_DB_URI = process.env.MONGODB_CAFE_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_cafe";

let server;
let baseUrl;
const cookies = {};
let tableNumber = 0;

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
const ok = async (method, path, options) => {
  const result = await api(method, path, options);
  assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
};
const db = () => mongoose.connection;

async function clearCafe() {
  for (const name of ["categories", "products", "stockmovements", "cafeorders", "bills", "payments", "sessions", "tables", "counters"]) {
    await db().collection(name).deleteMany({});
  }
  tableNumber = 0;
}

async function category(name = "Drinks") {
  return ok("POST", "/categories", { body: { name } });
}
async function product(categoryId, extra = {}) {
  return ok("POST", "/products", { body: { name: "Cola", categoryId, price: 8000, stockQuantity: 10, ...extra } });
}
async function runningSession() {
  tableNumber += 1;
  const table = await ok("POST", "/tables", { body: { tableNumber, hourlyRate: 1 } });
  return ok("POST", "/sessions", { body: { tableId: table.id } });
}
const endSession = (session) => ok("POST", `/sessions/${session.id}/end`);
const stockOf = async (id) => (await ok("GET", `/products/${id}`)).stockQuantity;
const PLAYERS = [{ name: "Ali", result: "loser" }, { name: "Usman", result: "winner" }];
const billBody = (session, extra = {}) => ({ sessionId: session.id, gameMode: "century", quantity: 1, payerRule: "loser", players: PLAYERS, ...extra });

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
  // Phase 11.3: Century is per billed minute. These sessions last seconds = the 15 min minimum,
  // so Rs 20/min keeps the game line at Rs 300 - the amount these café tests were written with.
  await api("PATCH", "/settings", { body: { gameRates: { century: 2000 }, framePrice: 15000 } });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------
// The billing maths (pure functions)
// ---------------------------------------------------------------------------

test("calculator: without a café payer rule the result is exactly the old calculation", () => {
  const input = {
    gameMode: "century", quantity: 1, unitPrice: 30000, taxEnabled: true, taxRateBasisPoints: 1600, payerRule: "split",
    players: [{ name: "A" }, { name: "B" }, { name: "C" }],
    cafeItems: [{ description: "Tea", quantity: 3, unitPrice: 8000 }],
  };
  const bill = calculateBill(input);
  assert.equal(bill.total, 54000 + 8640);
  assert.deepEqual(bill.players.map((p) => p.shareAmount), [20880, 20880, 20880]);
  assert.equal(bill.cafePayerRule, undefined);
  assert.ok(bill.players.every((p) => !("gameShare" in p)), "old bills keep their old shape");
  assert.deepEqual(Object.keys(bill.lineItems[1]).sort(), ["amount", "description", "quantity", "type", "unitPrice"]);
});

test("calculator: café payer rules - loser, split, consumer (with tax shared exactly)", () => {
  const base = {
    gameMode: "century", quantity: 1, unitPrice: 30000, payerRule: "winner",
    players: [{ name: "Ali", result: "loser" }, { name: "Usman", result: "winner" }, { name: "Sana" }],
    cafeItems: [
      { description: "Cola", quantity: 2, unitPrice: 8000, consumer: "Ali" },   // 160.00
      { description: "Chips", quantity: 1, unitPrice: 5000, consumer: "Sana" }, // 50.00
    ],
  };
  const loser = calculateBill({ ...base, cafePayerRule: "loser" });
  assert.deepEqual(loser.players.map((p) => [p.gameShare, p.cafeShare, p.shareAmount]), [[0, 21000, 21000], [30000, 0, 30000], [0, 0, 0]]);

  const split = calculateBill({ ...base, cafePayerRule: "split" });
  assert.deepEqual(split.players.map((p) => p.cafeShare), [7000, 7000, 7000]);

  const consumer = calculateBill({ ...base, cafePayerRule: "consumer" });
  assert.deepEqual(consumer.players.map((p) => p.cafeShare), [16000, 0, 5000]);
  assert.equal(consumer.cafePayerRule, "consumer");

  // With 16% tax: game 300 -> tax 48.00 for the winner; café 210 -> tax 33.60 shared 160:50
  const taxed = calculateBill({ ...base, cafePayerRule: "consumer", taxEnabled: true, taxRateBasisPoints: 1600 });
  assert.equal(taxed.taxAmount, 8160);
  assert.deepEqual(taxed.players.map((p) => p.gameShare), [0, 34800, 0]);
  assert.deepEqual(taxed.players.map((p) => p.cafeShare), [16000 + 2560, 0, 5000 + 800]);
  for (const bill of [loser, split, consumer, taxed]) {
    assert.equal(bill.players.reduce((sum, p) => sum + p.shareAmount, 0), bill.total, "shares always add up to the total");
  }
  // Game split + café split: the whole total is split at once, so the numbers match a pre-Phase-10 bill exactly
  const both = { ...base, payerRule: "split", cafeItems: [{ description: "Tea", quantity: 1, unitPrice: 16001 }] };
  const oldWay = calculateBill(both);
  const newWay = calculateBill({ ...both, cafePayerRule: "split" });
  assert.deepEqual(newWay.players.map((p) => p.shareAmount), oldWay.players.map((p) => p.shareAmount));
  assert.deepEqual(newWay.players.map((p) => p.gameShare + p.cafeShare), newWay.players.map((p) => p.shareAmount));
  // Game loser + café loser: also identical to the old "loser pays everything"
  const loserOld = calculateBill({ ...base, payerRule: "loser" });
  const loserNew = calculateBill({ ...base, payerRule: "loser", cafePayerRule: "loser" });
  assert.deepEqual(loserNew.players.map((p) => p.shareAmount), loserOld.players.map((p) => p.shareAmount));
  // Odd paisa of café tax go to the first consumers, one each, never lost
  assert.deepEqual(splitCafeShares(3, 1, [{ amount: 1, consumer: "A" }, { amount: 1, consumer: "B" }, { amount: 1, consumer: "C" }],
    [{ name: "A" }, { name: "B" }, { name: "C" }], "consumer"), [2, 1, 1]);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("permissions: view/sell for everyone, manage for admin, restock admin+staff, adjust admin", async () => {
  await clearCafe();
  const cat = await category();
  const prod = await product(cat.id);
  const session = await runningSession();
  const id = "0123456789abcdef01234567";
  const checks = [
    // [method, path, body, [admin, staff, cashier]]
    ["GET", "/categories", undefined, [200, 200, 200]],
    ["GET", "/products", undefined, [200, 200, 200]],
    ["POST", "/categories", { name: "Snacks" }, [201, 403, 403]],
    ["PATCH", `/categories/${cat.id}`, { name: "Drinks" }, [200, 403, 403]],
    ["DELETE", `/categories/${id}`, undefined, [404, 403, 403]],
    ["POST", "/products", { name: "Water", categoryId: cat.id, price: 5000 }, [201, 403, 403]],
    ["PATCH", `/products/${prod.id}`, { price: 8000 }, [200, 403, 403]],
    ["DELETE", `/products/${id}`, undefined, [404, 403, 403]],
    ["POST", `/products/${prod.id}/restock`, { quantity: 1 }, [201, 201, 403]],
    ["POST", `/products/${prod.id}/adjust`, { type: "adjustment", quantity: 1, reason: "count" }, [201, 403, 403]],
    ["GET", "/stock-movements", undefined, [200, 200, 403]],
    ["GET", `/products/${prod.id}/movements`, undefined, [200, 200, 403]],
    ["GET", `/sessions/${session.id}/cafe-items`, undefined, [200, 200, 200]],
    ["POST", `/sessions/${session.id}/cafe-items`, { description: "Tea", unitPrice: 5000, quantity: 1 }, [201, 201, 201]],
  ];
  for (const [method, path, body, expected] of checks) {
    const statuses = [];
    for (const role of ["admin", "staff", "cashier"]) statuses.push((await api(method, path, { body, cookie: cookies[role] })).status);
    assert.deepEqual(statuses, expected, `${method} ${path}`);
    assert.equal((await api(method, path, { body, cookie: null })).status, 401, `${method} ${path} logged out`);
  }
  // Pages
  const page = (p, role) => fetch(`${baseUrl}/pages/${p}.html`, { headers: { Cookie: cookies[role] }, redirect: "manual" });
  for (const role of ["admin", "staff", "cashier"]) {
    assert.equal((await page("products", role)).status, 200, `products page for ${role}`);
    assert.equal((await page("categories", role)).status, 200, `categories page for ${role}`);
  }
});

// ---------------------------------------------------------------------------
// Categories (Malik Module 3 rules)
// ---------------------------------------------------------------------------

test("categories: trimmed, unique without capitals, rename, search, delete rules", async () => {
  await clearCafe();
  const drinks = await category("  Soft   drinks ");
  assert.equal(drinks.name, "Soft drinks");
  assert.ok(!("nameKey" in drinks));
  for (const name of ["soft drinks", "SOFT DRINKS", " Soft  Drinks"]) {
    const dup = await api("POST", "/categories", { body: { name } });
    assert.equal(dup.status, 409, name);
    assert.equal(dup.body.message, "Category name already exists");
  }
  assert.equal((await api("POST", "/categories", { body: { name: "" } })).body.message, "Category name is required");
  assert.equal((await api("POST", "/categories", { body: { name: "A" } })).body.message, "Category name must be at least 2 characters");
  assert.equal((await api("POST", "/categories", { body: { name: "x".repeat(101) } })).body.message, "Category name must be at most 100 characters");
  // Renaming to the same name with other capitals is fine; to another category's name is not
  assert.equal((await ok("PATCH", `/categories/${drinks.id}`, { body: { name: "SOFT drinks" } })).name, "SOFT drinks");
  const snacks = await category("Snacks");
  assert.equal((await api("PATCH", `/categories/${snacks.id}`, { body: { name: "soft DRINKS" } })).status, 409);
  // Search and product counts
  await product(snacks.id, { name: "Chips" });
  const list = await ok("GET", "/categories?search=snack");
  assert.deepEqual(list.map((c) => [c.name, c.productCount]), [["Snacks", 1]]);
  // A category with products can't be deleted; an empty one can
  const blocked = await api("DELETE", `/categories/${snacks.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /it has 1 product\(s\)/);
  assert.equal((await api("DELETE", `/categories/${drinks.id}`)).status, 200);
  assert.equal((await api("GET", `/categories/${drinks.id}`)).status, 404);
});

// ---------------------------------------------------------------------------
// Products (Malik Module 4 rules)
// ---------------------------------------------------------------------------

test("products: validation, unique per category, stock only via movements, filters, delete rules", async () => {
  await clearCafe();
  const drinks = await category("Drinks");
  const snacks = await category("Snacks");
  const cola = await product(drinks.id, { name: " Cola  Zero ", stockQuantity: 12, lowStockLimit: 3 });
  assert.deepEqual([cola.name, cola.price, cola.stockQuantity, cola.lowStockLimit, cola.trackStock, cola.status, cola.isLowStock],
    ["Cola Zero", 8000, 12, 3, true, "active", false]);
  assert.deepEqual(cola.category, { id: drinks.id, name: "Drinks" });
  assert.equal(cola.availableQuantity, 12);
  // Starting stock is in the history
  const history = await ok("GET", `/products/${cola.id}/movements`);
  assert.deepEqual(history.movements.map((m) => [m.type, m.quantity, m.balanceAfter]), [["initial", 12, 12]]);

  // Same name in the same category (any capitals/spaces) -> 409; in another category -> fine
  const dup = await api("POST", "/products", { body: { name: "cola zero", categoryId: drinks.id, price: 1 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.message, "A product with this name already exists in this category");
  await product(snacks.id, { name: "COLA ZERO" });

  // Validation
  const bad = async (body, message) => {
    const { status, body: res } = await api("POST", "/products", { body: { name: "Tea", categoryId: drinks.id, price: 100, ...body } });
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(res), message);
  };
  await bad({ name: "" }, /Product name is required/);
  await bad({ price: -1 }, /Price must be between Rs 0/);
  await bad({ price: 12.5 }, /Price must be between Rs 0/);
  await bad({ stockQuantity: -2 }, /Starting stock must be a whole number/);
  await bad({ stockQuantity: 1_000_001 }, /Starting stock must be a whole number/);
  await bad({ categoryId: "0123456789abcdef01234567" }, /Category does not exist/);
  await bad({ trackStock: "yes" }, /Track stock must be true or false/);

  // Edit: stock can't be set; other fields change, stock stays
  const stockEdit = await api("PATCH", `/products/${cola.id}`, { body: { stockQuantity: 99 } });
  assert.equal(stockEdit.status, 400);
  assert.match(stockEdit.body.message, /Use Restock or Adjust stock/);
  const edited = await ok("PATCH", `/products/${cola.id}`, { body: { price: 9000, lowStockLimit: 20 } });
  assert.deepEqual([edited.price, edited.stockQuantity, edited.isLowStock], [9000, 12, true]);

  // Made-to-order product: no stock count
  const tea = await product(drinks.id, { name: "Tea", price: 5000, trackStock: false, stockQuantity: 50 });
  assert.deepEqual([tea.trackStock, tea.stockQuantity, tea.availableQuantity, tea.isLowStock], [false, 0, null, false]);
  assert.equal((await api("POST", `/products/${tea.id}/restock`, { body: { quantity: 5 } })).status, 409);

  // Filters
  const names = async (q) => (await ok("GET", `/products?${q}`)).map((p) => p.name).sort();
  assert.deepEqual(await names("lowStock=true"), ["Cola Zero"]);
  assert.deepEqual(await names(`categoryId=${snacks.id}`), ["COLA ZERO"]);
  assert.deepEqual(await names("search=tea"), ["Tea"]);
  assert.deepEqual(await names("trackStock=false"), ["Tea"]);
  await ok("PATCH", `/products/${tea.id}`, { body: { status: "inactive" } });
  assert.deepEqual(await names("status=active"), ["COLA ZERO", "Cola Zero"]);
  assert.deepEqual(await names("status=inactive"), ["Tea"]);

  // Delete: unused -> deleted; with history -> 409 "set it inactive"
  const water = await product(drinks.id, { name: "Water", stockQuantity: 5 });
  assert.equal((await api("DELETE", `/products/${water.id}`)).status, 200);
  await ok("POST", `/products/${cola.id}/restock`, { body: { quantity: 1 } });
  const used = await api("DELETE", `/products/${cola.id}`);
  assert.equal(used.status, 409);
  assert.match(used.body.message, /Set it to inactive instead/);
});

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

test("stock: restock, adjustment, waste - never below 0, reasons required, full history", async () => {
  await clearCafe();
  const cola = await product((await category()).id, { stockQuantity: 5 });
  const restocked = await ok("POST", `/products/${cola.id}/restock`, { body: { quantity: 24, reason: "Delivery" }, cookie: cookies.staff });
  assert.equal(restocked.product.stockQuantity, 29);
  assert.equal(restocked.movement.createdBy.username, "test-staff");

  assert.equal((await api("POST", `/products/${cola.id}/adjust`, { body: { type: "adjustment", quantity: -2 } })).status, 400, "reason required");
  await ok("POST", `/products/${cola.id}/adjust`, { body: { type: "adjustment", quantity: -4, reason: "Counted 25" } });
  await ok("POST", `/products/${cola.id}/adjust`, { body: { type: "waste", quantity: 3, reason: "Broken bottles" } });
  assert.equal(await stockOf(cola.id), 22);
  const below = await api("POST", `/products/${cola.id}/adjust`, { body: { type: "waste", quantity: 23, reason: "Too many" } });
  assert.equal(below.status, 409);
  assert.match(below.body.message, /Only 22 Cola in stock - stock can't go below 0/);
  assert.equal((await api("POST", `/products/${cola.id}/adjust`, { body: { type: "waste", quantity: -1, reason: "x" } })).status, 400);
  assert.equal((await api("POST", `/products/${cola.id}/restock`, { body: { quantity: 0 } })).status, 400);

  const { movements } = await ok("GET", `/stock-movements?productId=${cola.id}`);
  assert.deepEqual(movements.map((m) => [m.type, m.quantity, m.balanceAfter]),
    [["waste", -3, 22], ["adjustment", -4, 25], ["restock", 24, 29], ["initial", 5, 5]]);
  assert.equal((await ok("GET", "/stock-movements?type=waste")).total, 1);

  // 10 people taking 1 at the same moment from a stock of 5 -> exactly 5 succeed, stock 0, never negative
  const five = await product((await category("Snacks")).id, { name: "Chips", stockQuantity: 5 });
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    api("POST", `/products/${five.id}/adjust`, { body: { type: "waste", quantity: 1, reason: "race" } })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  assert.equal(await stockOf(five.id), 0);
});

// ---------------------------------------------------------------------------
// Session tab
// ---------------------------------------------------------------------------

test("session tab: add products and typed-in items, price copied, free stock respected, change and remove", async () => {
  await clearCafe();
  const drinks = await category();
  const cola = await product(drinks.id, { stockQuantity: 3 });
  const tea = await product(drinks.id, { name: "Tea", price: 5000, trackStock: false });
  const s1 = await runningSession();
  const s2 = await runningSession();

  const item = await ok("POST", `/sessions/${s1.id}/cafe-items`, { body: { productId: cola.id, quantity: 2, consumer: "Ali" }, cookie: cookies.cashier });
  assert.deepEqual([item.description, item.categoryName, item.unitPrice, item.quantity, item.consumer, item.status, item.addedBy.username],
    ["Cola", "Drinks", 8000, 2, "Ali", "open", "test-cashier"]);
  // Only 1 Cola is still free (2 are on table 1's tab)
  assert.equal((await ok("GET", `/products/${cola.id}`)).availableQuantity, 1);
  const tooMany = await api("POST", `/sessions/${s2.id}/cafe-items`, { body: { productId: cola.id, quantity: 2 } });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.message, "Only 1 Cola available");
  await ok("POST", `/sessions/${s2.id}/cafe-items`, { body: { productId: tea.id, quantity: 5 } }); // not counted: always available
  const manual = await ok("POST", `/sessions/${s1.id}/cafe-items`, { body: { description: "Samosa", unitPrice: 4000, quantity: 1 } });
  assert.equal(manual.product, null);

  // A later price change doesn't change what was already ordered
  await ok("PATCH", `/products/${cola.id}`, { body: { price: 9900 } });
  let tab = await ok("GET", `/sessions/${s1.id}/cafe-items`);
  assert.deepEqual(tab.items.map((i) => [i.description, i.unitPrice]), [["Cola", 8000], ["Samosa", 4000]]);
  assert.equal(tab.openTotal, 2 * 8000 + 4000);

  // Change quantity (stock check counts this item's own quantity) and remove
  assert.equal((await api("PATCH", `/sessions/${s1.id}/cafe-items/${item.id}`, { body: { quantity: 4 } })).status, 409);
  await ok("PATCH", `/sessions/${s1.id}/cafe-items/${item.id}`, { body: { quantity: 3 } });
  await ok("DELETE", `/sessions/${s1.id}/cafe-items/${manual.id}`);
  tab = await ok("GET", `/sessions/${s1.id}/cafe-items`);
  assert.deepEqual(tab.items.map((i) => [i.description, i.quantity]), [["Cola", 3]]);
  assert.equal((await db().collection("cafeorders").findOne({ description: "Samosa" })).status, "removed", "kept for history");

  // Inactive products and validation
  await ok("PATCH", `/products/${tea.id}`, { body: { status: "inactive" } });
  assert.equal((await api("POST", `/sessions/${s1.id}/cafe-items`, { body: { productId: tea.id, quantity: 1 } })).status, 409);
  assert.equal((await api("POST", `/sessions/${s1.id}/cafe-items`, { body: { quantity: 1 } })).status, 400);
  assert.equal((await api("POST", `/sessions/${s1.id}/cafe-items`, { body: { description: "Pie", quantity: 1 } })).body.message, "Enter the price");
  assert.equal((await api("POST", "/sessions/0123456789abcdef01234567/cafe-items", { body: { description: "Pie", unitPrice: 1, quantity: 1 } })).status, 404);

  // After billing the tab is closed
  await endSession(s1);
  await ok("POST", "/bills", { body: billBody(s1) });
  const late = await api("POST", `/sessions/${s1.id}/cafe-items`, { body: { description: "Pie", unitPrice: 1, quantity: 1 } });
  assert.equal(late.status, 409);
  assert.match(late.body.message, /already billed/);
});

// ---------------------------------------------------------------------------
// Billing with café items
// ---------------------------------------------------------------------------

test("bill: tab items + window items + typed-in items, stock taken on bill creation, history copied", async () => {
  await clearCafe();
  const drinks = await category();
  const cola = await product(drinks.id, { stockQuantity: 10 });
  const chips = await product((await category("Snacks")).id, { name: "Chips", price: 5000, stockQuantity: 4 });
  const tea = await product(drinks.id, { name: "Tea", price: 3000, trackStock: false });
  const session = await runningSession();
  const tabCola = await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 2, consumer: "ali" } });
  const tabTea = await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: tea.id, quantity: 1 } });
  assert.equal(await stockOf(cola.id), 10, "adding to the tab does not take stock yet");
  await endSession(session);

  const input = billBody(session, {
    cafeItems: [{ productId: chips.id, quantity: 3, consumer: "Usman" }, { description: "Samosa", quantity: 1, unitPrice: 4000, consumer: "Ali" }],
    tabItems: [{ id: tabCola.id, consumer: "Ali" }, { id: tabTea.id, consumer: "Usman" }], // who had the tab items
    cafePayerRule: "consumer",
  });
  const preview = await ok("POST", "/bills/preview", { body: input });
  assert.equal(preview.tabItemCount, 2);
  assert.equal(await stockOf(chips.id), 4, "preview takes nothing");

  const bill = await ok("POST", "/bills", { body: input, cookie: cookies.cashier });
  const cafe = bill.lineItems.filter((l) => l.type === "cafe");
  assert.deepEqual(cafe.map((l) => [l.description, l.quantity, l.unitPrice, l.amount, l.categoryName, l.consumer]), [
    ["Cola", 2, 8000, 16000, "Drinks", "Ali"],
    ["Tea", 1, 3000, 3000, "Drinks", "Usman"],
    ["Chips", 3, 5000, 15000, "Snacks", "Usman"],
    ["Samosa", 1, 4000, 4000, undefined, "Ali"],
  ].map(([d, q, u, a, c, n]) => [d, q, u, a, c, n]));
  assert.equal(cafe[0].product, cola.id);
  assert.equal(cafe[0].cafeOrder, tabCola.id);
  assert.equal(bill.total, 30000 + 16000 + 3000 + 15000 + 4000);
  assert.equal(bill.cafePayerRule, "consumer");
  // Ali (loser) pays the game + his Cola and Samosa; Usman pays his Tea and Chips
  assert.deepEqual(bill.players.map((p) => [p.name, p.gameShare, p.cafeShare]), [["Ali", 30000, 20000], ["Usman", 0, 18000]]);

  // Stock: taken now, with "sale" history linked to the bill; Tea (not counted) untouched
  assert.equal(await stockOf(cola.id), 8);
  assert.equal(await stockOf(chips.id), 1);
  const sales = await ok("GET", `/stock-movements?type=sale`);
  assert.deepEqual(sales.movements.map((m) => [m.productName, m.quantity, m.billNumber]).sort(),
    [["Chips", -3, bill.billNumber], ["Cola", -2, bill.billNumber]]);
  // Tab items now belong to the bill
  const tab = await ok("GET", `/sessions/${session.id}/cafe-items`);
  assert.ok(tab.billed && tab.items.every((i) => i.status === "billed" && i.bill === bill.id));

  // Changing products, prices and categories never changes the saved bill
  await ok("PATCH", `/products/${cola.id}`, { body: { name: "Cola Classic", price: 1 } });
  await ok("PATCH", `/categories/${drinks.id}`, { body: { name: "Cold drinks" } });
  const again = await ok("GET", `/bills/${bill.id}`);
  assert.deepEqual(again.lineItems, bill.lineItems);
  assert.equal(again.total, bill.total);
});

test("bill: café payer rules on real bills; legacy bills (no café rule) unchanged; bad input refused", async () => {
  await clearCafe();
  const cola = await product((await category()).id, { stockQuantity: 50 });
  const make = async (extra) => {
    const session = await runningSession();
    await endSession(session);
    return api("POST", "/bills", { body: billBody(session, extra) });
  };

  // Legacy: café follows the bill's rule (loser pays everything) - same as before Phase 10
  const legacy = await make({ cafeItems: [{ description: "Tea", quantity: 2, unitPrice: 5000 }] });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.data.cafePayerRule, null);
  assert.deepEqual(legacy.body.data.players.map((p) => [p.name, p.shareAmount, p.gameShare]), [["Ali", 40000, undefined], ["Usman", 0, undefined]]);

  // Game: loser pays; café: split equally
  const split = (await make({ cafeItems: [{ productId: cola.id, quantity: 2 }], cafePayerRule: "split" })).body.data;
  assert.deepEqual(split.players.map((p) => [p.gameShare, p.cafeShare, p.shareAmount]), [[30000, 8000, 38000], [0, 8000, 8000]]);
  // Game: split; café: the loser pays
  const loser = (await make({ payerRule: "split", cafeItems: [{ productId: cola.id, quantity: 1 }], cafePayerRule: "loser" })).body.data;
  assert.deepEqual(loser.players.map((p) => [p.gameShare, p.cafeShare]), [[15000, 8000], [15000, 0]]);

  // Payments work per player as before
  const pay = await api("POST", `/bills/${split.id}/payments`, { body: { amount: 8000, method: "cash", payerName: "Usman" } });
  assert.equal(pay.status, 201);
  assert.equal((await api("POST", `/bills/${split.id}/payments`, { body: { amount: 1, method: "cash", payerName: "Usman" } })).status, 409, "Usman only owes his share");

  // Consumer pays: every item needs a player
  const noConsumer = await make({ cafeItems: [{ productId: cola.id, quantity: 1 }], cafePayerRule: "consumer" });
  assert.equal(noConsumer.status, 400);
  assert.match(noConsumer.body.message, /Consumer pays: choose which player had Cola/);
  const stranger = await make({ cafeItems: [{ productId: cola.id, quantity: 1, consumer: "Bilal" }], cafePayerRule: "consumer" });
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.message, /Bilal is not a player on this bill/);
  // Loser pays café: a loser must be marked
  const noLoser = await make({ payerRule: "split", players: [{ name: "A" }, { name: "B" }], cafeItems: [{ productId: cola.id, quantity: 1 }], cafePayerRule: "loser" });
  assert.equal(noLoser.status, 400);
  assert.match(noLoser.body.message, /the loser pays for the café/);
  assert.equal((await make({ cafePayerRule: "everyone" })).status, 400);
  // Refused bills took no stock
  assert.equal(await stockOf(cola.id), 50 - 2 - 1);
});

test("bill: zero stock blocks the sale; last item race leaves stock at 0, never negative; cancel puts stock back", async () => {
  await clearCafe();
  const cola = await product((await category()).id, { stockQuantity: 1 });

  // Two tables both get the last Cola onto their tab? The second can't (only 1 free)
  const s1 = await runningSession();
  const s2 = await runningSession();
  await ok("POST", `/sessions/${s1.id}/cafe-items`, { body: { productId: cola.id, quantity: 1 } });
  assert.equal((await api("POST", `/sessions/${s2.id}/cafe-items`, { body: { productId: cola.id, quantity: 1 } })).status, 409);

  // In the bill window both ask for the last Cola at the same moment -> one bill, stock 0
  const [a, b] = [await runningSession(), await runningSession()];
  await endSession(a);
  await endSession(b);
  await ok("DELETE", `/sessions/${s1.id}/cafe-items/${(await ok("GET", `/sessions/${s1.id}/cafe-items`)).items[0].id}`);
  const results = await Promise.all([a, b].map((s) => api("POST", "/bills", { body: billBody(s, { cafeItems: [{ productId: cola.id, quantity: 1 }] }) })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.match(results.find((r) => r.status === 409).body.message, /Not enough stock: Cola has 0 left/);
  assert.equal(await stockOf(cola.id), 0);
  assert.equal(await db().collection("bills").countDocuments(), 1, "the refused bill was not saved");

  // Zero stock: blocked in the window and on the tab
  await endSession(s2);
  const blocked = await api("POST", "/bills", { body: billBody(s2, { cafeItems: [{ productId: cola.id, quantity: 1 }] }) });
  assert.equal(blocked.status, 409);
  assert.equal((await api("POST", `/sessions/${s1.id}/cafe-items`, { body: { productId: cola.id, quantity: 1 } })).body.message, "Cola is out of stock");

  // Cancel before payment: stock back + "sale_reversal" history; can't happen twice
  const sold = results.find((r) => r.status === 201).body.data;
  await ok("POST", `/bills/${sold.id}/cancel`, { body: { reason: "Wrong table" } });
  assert.equal(await stockOf(cola.id), 1);
  const reversal = await ok("GET", "/stock-movements?type=sale_reversal");
  assert.deepEqual(reversal.movements.map((m) => [m.quantity, m.balanceAfter, m.billNumber]), [[1, 1, sold.billNumber]]);
  assert.equal((await api("POST", `/bills/${sold.id}/cancel`, { body: {} })).status, 409);
  assert.equal(await stockOf(cola.id), 1, "a second cancel doesn't add stock again");

  // A paid bill can't be cancelled (unchanged rule), so its stock stays sold
  const paidSession = await runningSession();
  await endSession(paidSession);
  const paidBill = await ok("POST", "/bills", { body: billBody(paidSession, { cafeItems: [{ productId: cola.id, quantity: 1 }] }) });
  await ok("POST", `/bills/${paidBill.id}/payments`, { body: { amount: 1000, method: "cash", payerName: "Ali" } });
  assert.equal((await api("POST", `/bills/${paidBill.id}/cancel`, { body: {} })).status, 409);
  assert.equal(await stockOf(cola.id), 0);
});

test("bill: inactive products can't be added in the bill window; tab items ordered before still bill", async () => {
  await clearCafe();
  const cola = await product((await category()).id, { stockQuantity: 5 });
  const session = await runningSession();
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 1 } });
  await ok("PATCH", `/products/${cola.id}`, { body: { status: "inactive" } });
  await endSession(session);
  const refused = await api("POST", "/bills/preview", { body: billBody(session, { cafeItems: [{ productId: cola.id, quantity: 1 }] }) });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /Cola is not on sale/);
  const bill = await ok("POST", "/bills", { body: billBody(session) });
  assert.deepEqual(bill.lineItems.filter((l) => l.type === "cafe").map((l) => l.description), ["Cola"]);
  assert.equal(await stockOf(cola.id), 4);
});
