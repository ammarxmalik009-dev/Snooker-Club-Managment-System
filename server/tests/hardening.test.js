// Tests for Phase 11.8 (final checks): page guard on encoded paths, the match's bill as the source of
// truth (paid-bill protection, pointer repair, no duplicate bill), the café tab on the last billable
// match, "billed per match" counts, single query values, the open-sessions index, the test-database
// guard and the admin password reset command.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mongoose = require("mongoose");
const { dropTestDatabase, assertTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs, TEST_PASSWORD } = require("./helpers/auth");
const { canonicalPagePath } = require("../middleware/auth");

const TEST_DB_URI = process.env.MONGODB_HARDENING_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_hardening";
const RATES = { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 };

let server;
let baseUrl;
let port;
const cookies = {};
let tableNumber = 0;

async function api(method, urlPath, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${urlPath}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, text };
}
async function ok(method, urlPath, options) {
  const result = await api(method, urlPath, options);
  assert.ok(result.status < 300, `${method} ${urlPath} -> ${result.status} ${result.text}`);
  return result.body.data;
}
// A raw GET, exactly as written (fetch would tidy "/css/../pages" before sending), no redirects followed
function rawGet(rawPath, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: rawPath, headers: cookie ? { Cookie: cookie } : {} }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location || null, body }));
    });
    request.on("error", reject);
  });
}

const db = () => mongoose.connection;
const oid = (id) => new mongoose.Types.ObjectId(id);
const walkIn = (name, extra = {}) => ({ playerId: null, name, ...extra });

async function openSession() {
  tableNumber += 1;
  const table = await ok("POST", "/tables", { body: { tableNumber, name: `T${tableNumber}`, hourlyRate: 1 } });
  return ok("POST", "/sessions", { body: { tableId: table.id } });
}
async function endSession(session, minutes = 20) {
  await db().collection("sessions").updateOne({ _id: oid(session.id) }, { $set: { startedAt: new Date(Date.now() - minutes * 60000) } });
  return ok("POST", `/sessions/${session.id}/end`);
}
async function playMatch(session, gameMode, players, result) {
  const match = await ok("POST", `/sessions/${session.id}/matches`, { body: { gameMode, players } });
  return result ? ok("POST", `/matches/${match.id}/complete`, { body: result }) : match;
}
const billMatch = (match, body = { payerRule: "loser" }) => api("POST", `/matches/${match.id}/bill`, { body });
const pay = (bill, payerName, amount) => ok("POST", `/bills/${bill.id}/payments`, { body: { amount, method: "cash", payerName }, cookie: cookies.cashier });
const changeResult = (match, winnerSeat, role) => api("POST", `/matches/${match.id}/result`, { body: { winnerSeat }, cookie: cookies[role] });
const dropPointer = (match) => db().collection("matches").updateOne({ _id: oid(match.id) }, { $set: { bill: null } });
const pointerOf = async (match) => (await db().collection("matches").findOne({ _id: oid(match.id) })).bill;
const billDoc = (bill) => db().collection("bills").findOne({ _id: oid(bill.id) });

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  for (const role of ["admin", "staff", "cashier"]) cookies[role] = await loginAs(baseUrl, role);
  await ok("PATCH", "/settings", { body: { gameRates: RATES } });
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
// 1. Page guard: the rules are applied to the canonical path
// ---------------------------------------------------------------------------

test("page guard: canonical path - decoded, '\\' as '/', dot segments and double slashes resolved, lower case", () => {
  assert.deepEqual(canonicalPagePath("/pages/users%2Ehtml"), { decoded: "/pages/users.html", canonical: "/pages/users.html" });
  assert.equal(canonicalPagePath("/pages//USERS.html").canonical, "/pages/users.html");
  assert.equal(canonicalPagePath("/css/../pages/users.html").canonical, "/pages/users.html");
  assert.equal(canonicalPagePath("/pages%2Fusers.html").canonical, "/pages/users.html");
  assert.equal(canonicalPagePath("/pages%5Cusers.html").canonical, "/pages/users.html");
  assert.equal(canonicalPagePath("/pages/%E0%A4%A.html"), null, "an address that can't be decoded");
});

test("page guard: not logged in - every spelling of a protected page ends at the login page, never the page", async () => {
  const plain = await rawGet("/pages/users.html");
  assert.deepEqual([plain.status, plain.location], [302, "/pages/login.html?next=%2Fpages%2Fusers.html"]);
  // The reported bypass: "users%2Ehtml" used to be served without a login
  for (const variant of ["/pages/users%2Ehtml", "/pages//users.html", "/pages/USERS.html", "/pages/Users.HTML", "/css/../pages/users.html",
    "/pages%2Fusers.html", "/pages/./users.html", "/js/%2E%2E/pages/settings.html", "/pages/%75sers.html"]) {
    const first = await rawGet(variant);
    assert.equal(first.status, 302, variant);
    assert.ok(!first.body.includes("<title>Users") && !first.body.includes("<title>Settings"), `${variant}: page content leaked`);
    assert.match(first.location, /^\/pages\/(users|settings)\.html$/, `${variant} -> canonical address`);
    const second = await rawGet(first.location);
    assert.deepEqual([second.status, second.location.startsWith("/pages/login.html?next=")], [302, true], `${variant}: login required`);
  }
  // Names that aren't plain page names: 404, never a file
  for (const odd of ["/pages/users.html.", "/pages/users.html%20", "/pages/users.html%00", "/pages/users.html::$DATA", "/pages/", "/pages/sub/users.html"]) {
    const response = await rawGet(odd);
    assert.equal(response.status, 404, odd);
    assert.ok(!response.body.includes("<title>Users"), odd);
  }
  assert.equal((await rawGet("/pages/%E0%A4%A.html")).status, 400);
});

test("page guard: logged-in roles - wrong role refused for every spelling, allowed role served, public pages and files unchanged", async () => {
  // Cashier: no Users / Settings / Reports, whatever the spelling
  for (const variant of ["/pages/users%2Ehtml", "/pages/REPORTS.html", "/pages//settings.html"]) {
    const first = await rawGet(variant, cookies.cashier);
    assert.equal(first.status, 302, variant);
    const second = await rawGet(first.location, cookies.cashier);
    assert.deepEqual([second.status, second.location], [302, "/pages/dashboard.html?denied=1"], variant);
  }
  // Staff: Reports yes, Users no
  assert.equal((await rawGet("/pages/reports.html", cookies.staff)).status, 200);
  assert.equal((await rawGet("/pages/users.html", cookies.staff)).location, "/pages/dashboard.html?denied=1");
  // Admin: served; a variant is sent to the canonical address first (query kept)
  const admin = await rawGet("/pages/users.html", cookies.admin);
  assert.ok(admin.status === 200 && admin.body.includes("<title>Users"));
  const variant = await rawGet("/pages/Reports.html?from=2026-09-01&to=2026-09-02", cookies.admin);
  assert.deepEqual([variant.status, variant.location], [302, "/pages/reports.html?from=2026-09-01&to=2026-09-02"]);
  // Public and normal routes
  assert.equal((await rawGet("/pages/login.html")).status, 200);
  assert.equal((await rawGet("/pages/LOGIN.html")).location, "/pages/login.html");
  assert.equal((await rawGet("/css/theme.css")).status, 200);
  assert.equal((await rawGet("/js/pages/users.js")).status, 200, "a script under /js/pages is not a page");
  assert.equal((await rawGet("/")).location, "/pages/dashboard.html");
  assert.equal((await rawGet("/api/health")).status, 200);
});

// ---------------------------------------------------------------------------
// 2. The match's bill: paid-bill protection, pointer repair, no duplicate bill
// ---------------------------------------------------------------------------

// A completed, billed Frame match (A beat B; B owes Rs 250). paid: 0, "partial" (Rs 100) or "full".
async function billedMatch({ paid = 0, dropThePointer = false } = {}) {
  const session = await openSession();
  const match = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await endSession(session);
  const bill = (await billMatch(match)).body.data;
  if (paid === "partial") await pay(bill, "B", 10000);
  if (paid === "full") await pay(bill, "B", 25000);
  if (dropThePointer) await dropPointer(match);
  return { session, match, bill };
}

test("result change, pointer present: unpaid -> staff and cashier may correct; partly or fully paid -> admin only", async () => {
  const unpaid = await billedMatch();
  assert.equal((await changeResult(unpaid.match, 2, "staff")).status, 200);
  assert.equal((await changeResult(unpaid.match, 1, "cashier")).status, 200);
  for (const paid of ["partial", "full"]) {
    const { match, bill } = await billedMatch({ paid });
    const before = await billDoc(bill);
    for (const role of ["staff", "cashier"]) {
      const refused = await changeResult(match, 2, role);
      assert.equal(refused.status, 403, `${paid} ${role}`);
      assert.match(refused.body.message, /already has payments\. Only an admin can change the result/);
    }
    assert.equal((await changeResult(match, 2, "admin")).status, 200, `${paid}: admin may correct`);
    const after = await billDoc(bill);
    assert.deepEqual([after.total, after.amountPaid, after.status, after.players], [before.total, before.amountPaid, before.status, before.players], "the bill never changes");
  }
});

test("result change, pointer MISSING: the bill is still found - paid bills stay admin-only, and the pointer is repaired", async () => {
  const unpaid = await billedMatch({ dropThePointer: true });
  assert.equal(await pointerOf(unpaid.match), null);
  assert.equal((await changeResult(unpaid.match, 2, "staff")).status, 200, "unpaid: the usual rule");
  assert.equal(String(await pointerOf(unpaid.match)), unpaid.bill.id, "pointer repaired");

  for (const paid of ["partial", "full"]) {
    const { match, bill } = await billedMatch({ paid, dropThePointer: true });
    for (const role of ["staff", "cashier"]) {
      await dropPointer(match);
      assert.equal((await changeResult(match, 2, role)).status, 403, `${paid}, no pointer, ${role}: still refused`);
    }
    assert.equal(String(await pointerOf(match)), bill.id, "pointer repaired");
    await dropPointer(match);
    const admin = await changeResult(match, 2, "admin");
    assert.equal(admin.status, 200, `${paid}: admin may correct`);
    assert.equal(admin.body.data.bill, bill.id);
  }
});

test("pointer missing: the Matches window, session history, reports and player history still show the bill; no second bill can be made", async () => {
  const { session, match, bill } = await billedMatch({ paid: "partial", dropThePointer: true });
  const list = await ok("GET", `/sessions/${session.id}/matches`);
  assert.deepEqual([list[0].bill, list[0].billInfo.billNumber, list[0].billInfo.status], [bill.id, bill.billNumber, "partially_paid"]);
  assert.equal(String(await pointerOf(match)), bill.id, "the list repaired the pointer");

  await dropPointer(match);
  const again = await billMatch(match);
  assert.equal(again.status, 409);
  assert.equal(again.body.message, `Match #1 already has bill ${bill.billNumber}`);
  assert.equal(await db().collection("bills").countDocuments({ match: oid(match.id) }), 1, "never a duplicate");
  assert.equal(String(await pointerOf(match)), bill.id, "repaired by the refused attempt too");

  await dropPointer(match);
  const history = (await ok("GET", "/sessions?limit=100")).sessions.find((s) => s.id === session.id);
  assert.equal(history.matches.billed, 1, "counted from the bills, not the pointer");
  const reportRow = (await ok("GET", "/reports/matches?preset=today")).matches.find((m) => m.id === match.id);
  assert.equal(reportRow.bill.billNumber, bill.billNumber, "Matches report finds it by the bill's match reference");
});

// ---------------------------------------------------------------------------
// 3. The café tab on the session's last billable match
// ---------------------------------------------------------------------------

async function cafeProduct(name, stockQuantity = 5) {
  const category = await ok("POST", "/categories", { body: { name: `${name} cat` } });
  return ok("POST", "/products", { body: { name, categoryId: category.id, price: 8000, stockQuantity } });
}
const stockOf = async (product) => (await ok("GET", `/products/${product.id}`)).stockQuantity;
const tabStatuses = async (session) => (await ok("GET", `/sessions/${session.id}/cafe-items`)).items.map((i) => i.status);

test("café tab: an earlier match may leave it for a later one; the LAST billable match must take it (server refuses, stock untouched)", async () => {
  const cola = await cafeProduct("Cola", 5);
  const session = await openSession();
  const first = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const second = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 2 });
  await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: cola.id, quantity: 2 } });
  await endSession(session);

  const preview1 = await ok("POST", `/matches/${first.id}/bill/preview`, { body: { payerRule: "loser" } });
  assert.equal(preview1.cafeTabMustStay, false, "match #2 can still take the tab");
  const left = await billMatch(first, { payerRule: "loser", includeCafeTab: false });
  assert.equal(left.status, 201);
  assert.deepEqual([left.body.data.lineItems.length, await stockOf(cola), await tabStatuses(session)], [1, 5, ["open"]]);

  const preview2 = await ok("POST", `/matches/${second.id}/bill/preview`, { body: { payerRule: "loser" } });
  assert.equal(preview2.cafeTabMustStay, true, "the last chance");
  const refused = await billMatch(second, { payerRule: "loser", includeCafeTab: false });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.message, "This is the last match of the session that can be billed, so the session's café tab (1 item) must go on this bill.");
  assert.equal((await api("POST", `/matches/${second.id}/bill/preview`, { body: { payerRule: "loser", includeCafeTab: false } })).status, 409, "the preview says so too");
  assert.deepEqual([await stockOf(cola), await tabStatuses(session), await db().collection("bills").countDocuments({ match: oid(second.id) })], [5, ["open"], 0], "nothing billed, nothing taken");

  const taken = await billMatch(second, { payerRule: "loser" });
  assert.equal(taken.status, 201);
  assert.deepEqual([taken.body.data.total, await stockOf(cola), await tabStatuses(session)], [25000 + 16000, 3, ["billed"]], "stock taken once, atomically");
});

test("café tab: what counts as 'another billable match' - in progress yes; cancelled, billed, a second Century or a Rs 0 game type no", async () => {
  const tea = await cafeProduct("Tea", 50);
  const scenario = async (others, gameMode = "frame") => {
    const session = await openSession();
    const match = await playMatch(session, gameMode, [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
    for (const other of others) {
      const m = await playMatch(session, other.mode || "frame", other.players || [walkIn("A"), walkIn("B")], other.status === "in_progress" || other.status === "cancelled" ? null : { winnerSeat: 1 });
      if (other.status === "cancelled") await ok("POST", `/matches/${m.id}/cancel`, { body: {} });
      if (other.status === "billed") other.billAfterEnd = m;
    }
    await ok("POST", `/sessions/${session.id}/cafe-items`, { body: { productId: tea.id, quantity: 1 } });
    await endSession(session);
    for (const other of others) if (other.billAfterEnd) assert.equal((await billMatch(other.billAfterEnd, { payerRule: "loser", includeCafeTab: false })).status, 201);
    return (await billMatch(match, { payerRule: "loser", includeCafeTab: false })).status;
  };
  assert.equal(await scenario([{ status: "in_progress" }]), 201, "a match still in progress can be completed and billed later");
  assert.equal(await scenario([{ status: "cancelled" }]), 409, "a cancelled match is never billed");
  assert.equal(await scenario([{ status: "billed" }, { status: "cancelled" }]), 409, "an already billed match can't take it");
  assert.equal(await scenario([{ mode: "century" }], "century"), 409, "a second Century match can never be billed (the session's time is charged once)");
  assert.equal(await scenario([{ mode: "century" }], "frame"), 201, "a Century match after a Frame bill can still be billed");
  await ok("PATCH", "/settings", { body: { gameRates: { ...RATES, snooker_point: 0 } } });
  assert.equal(await scenario([{ mode: "snooker_point", players: [walkIn("A"), walkIn("B"), walkIn("C")] }]), 409, "a game type switched off (Rs 0) can't be billed");
  await ok("PATCH", "/settings", { body: { gameRates: RATES } });
});

test("café tab: no open items or an already billed tab -> leaving it out is fine on the last match", async () => {
  const session = await openSession();
  const only = await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await endSession(session);
  const preview = await ok("POST", `/matches/${only.id}/bill/preview`, { body: { payerRule: "loser" } });
  assert.equal(preview.cafeTabMustStay, false);
  assert.equal((await billMatch(only, { payerRule: "loser", includeCafeTab: false })).status, 201, "no café items: normal");

  const juice = await cafeProduct("Juice", 4);
  const s2 = await openSession();
  const a = await playMatch(s2, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  const b = await playMatch(s2, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 });
  await ok("POST", `/sessions/${s2.id}/cafe-items`, { body: { productId: juice.id, quantity: 1 } });
  await endSession(s2);
  assert.equal((await billMatch(a)).status, 201, "the tab goes on the first bill");
  assert.equal((await billMatch(b, { payerRule: "loser", includeCafeTab: false })).status, 201, "tab already billed: normal");
  assert.equal(await stockOf(juice), 3);
});

// ---------------------------------------------------------------------------
// 4. "Billed per match": a cancelled bill is not billed
// ---------------------------------------------------------------------------

test("billed per match: unpaid, partly paid and paid bills count; a cancelled bill and an unbilled match don't (same as the Matches report)", async () => {
  const session = await openSession();
  const m = [];
  for (let i = 0; i < 5; i += 1) m.push(await playMatch(session, "frame", [walkIn("A"), walkIn("B")], { winnerSeat: 1 }));
  const cancelledMatch = await playMatch(session, "frame", [walkIn("A"), walkIn("B")]);
  await ok("POST", `/matches/${cancelledMatch.id}/cancel`, { body: {} });
  await endSession(session);
  const unpaid = (await billMatch(m[0])).body.data;
  const partial = (await billMatch(m[1])).body.data;
  await pay(partial, "B", 10000);
  const paid = (await billMatch(m[2])).body.data;
  await pay(paid, "B", 25000);
  const cancelled = (await billMatch(m[3])).body.data;
  await ok("POST", `/bills/${cancelled.id}/cancel`, { body: {}, cookie: cookies.cashier });
  // m[4]: completed, never billed

  const summary = (await ok("GET", "/sessions?limit=100")).sessions.find((s) => s.id === session.id).matches;
  assert.deepEqual(summary, { total: 6, inProgress: 0, completed: 5, cancelled: 1, billed: 3 });
  const dashboardRow = (await ok("GET", "/dashboard/summary")).recentSessions.find((s) => s.id === session.id);
  assert.deepEqual(dashboardRow.matches, summary, "the dashboard says the same");
  const report = (await ok("GET", "/reports/matches?preset=today")).matches.filter((row) => row.tableNumber === tableNumber);
  assert.equal(report.filter((row) => row.bill && row.bill.status !== "cancelled").length, summary.billed, "the Matches report agrees");
  assert.equal((await billDoc(cancelled)).status, "cancelled", "the cancelled bill itself is unchanged");
  assert.equal(unpaid.status, "unpaid");
});

// ---------------------------------------------------------------------------
// 5. Query values, index, test-database guard
// ---------------------------------------------------------------------------

test("query values: a key given twice is a clear 400 (it used to reach the database as a list); single values work", async () => {
  for (const urlPath of ["/bills?page=1&page=2", "/reports/revenue?preset=today&preset=last7", "/players?search=a&search=b", "/sessions?limit=5&limit=6", "/reports/export/matches?sort=newest&sort=oldest"]) {
    const response = await api("GET", urlPath);
    assert.equal(response.status, 400, urlPath);
    assert.match(response.body.message, /can only be given once/);
    assert.equal(response.body.errors.length, 1);
  }
  assert.equal((await api("GET", "/bills?page=1&limit=5")).status, 200);
  assert.equal((await api("GET", "/reports/revenue?preset=today")).status, 200);
});

test("index: 'sessions running now' uses the open_sessions_by_start index (not a scan of every session ever played)", async () => {
  const plan = JSON.stringify(await db().collection("sessions").find({ isOpen: true }).sort({ startedAt: 1 }).explain("queryPlanner"));
  assert.ok(plan.includes("open_sessions_by_start") && !plan.includes("COLLSCAN"), plan.slice(0, 400));
  const indexes = await db().collection("sessions").indexes();
  const index = indexes.find((i) => i.name === "open_sessions_by_start");
  assert.deepEqual([index.key, index.partialFilterExpression], [{ startedAt: 1 }, { isOpen: true }]);
  assert.ok(indexes.some((i) => i.name === "one_open_session_per_table"), "the one-open-session-per-table rule is still there");
});

test("test-database guard: a database without 'test' in its name is never dropped", async () => {
  let dropped = false;
  const realLooking = { name: "snooker_club_pro", dropDatabase: async () => { dropped = true; } };
  await assert.rejects(dropTestDatabase(realLooking), /Refusing to delete the database "snooker_club_pro".*Nothing was deleted/);
  assert.equal(dropped, false);
  assert.throws(() => assertTestDatabase({ name: "" }), /Refusing/);
  assert.equal(assertTestDatabase(mongoose.connection), "snooker_club_pro_test_hardening");
});

// ---------------------------------------------------------------------------
// 6. npm run reset-admin-password (run last: it changes the admin's password)
// ---------------------------------------------------------------------------

const SCRIPT = path.join(__dirname, "..", "scripts", "resetAdminPassword.js");
function runReset(answers, uri = TEST_DB_URI) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, MONGODB_URI: uri }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
    child.stdin.end(answers.map((line) => `${line}\n`).join(""));
  });
}
const login = (username, password) => api("POST", "/auth/login", { body: { username, password }, cookie: null });

test("reset-admin-password: refuses staff, refuses a weak password, and is cancelled without changing anything", async () => {
  const usersBefore = await db().collection("users").countDocuments();
  const staff = await runReset(["test-staff"]);
  assert.equal(staff.code, 1);
  assert.match(staff.output, /That is not an active admin/);
  assert.match(staff.output, /The password was NOT changed/);
  assert.equal((await login("test-staff", TEST_PASSWORD)).status, 200, "staff password unchanged");

  const weak = await runReset(["test-admin", "short1", "alsoweak"]);
  assert.equal(weak.code, 1);
  assert.match(weak.output, /Password must be at least 10 characters/);
  assert.ok(!weak.output.includes("short1") && !weak.output.includes("alsoweak"), "a typed password is never printed");
  assert.equal((await login("test-admin", TEST_PASSWORD)).status, 200, "admin password unchanged");
  assert.equal(await db().collection("users").countDocuments(), usersBefore, "no user created");
});

test("reset-admin-password: with no active admin it fails clearly and creates nobody", async () => {
  const emptyUri = TEST_DB_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_noadmin$2");
  const other = mongoose.createConnection(emptyUri);
  await other.asPromise();
  try {
    const result = await runReset(["anyone"], emptyUri);
    assert.equal(result.code, 1);
    assert.match(result.output, /There is no active admin\. Nothing was changed\. Create the first admin with: npm\.cmd run create-admin/);
    assert.equal(await other.collection("users").countDocuments(), 0, "no admin created");
  } finally {
    await dropTestDatabase(other);
    await other.close();
  }
});

test("reset-admin-password: the admin gets the new password (same rules), all their logins end, nothing printed, no duplicate", async () => {
  const usersBefore = await db().collection("users").countDocuments();
  const NEW = "Reset-pass-2468";
  const result = await runReset(["", NEW, NEW]); // Enter = the only active admin
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /The password of admin "test-admin" was changed and all their logins were ended/);
  assert.ok(!result.output.includes(NEW), "the new password is never printed");
  assert.equal((await api("GET", "/auth/me", { cookie: cookies.admin })).status, 401, "the old login ended");
  assert.equal((await login("test-admin", TEST_PASSWORD)).status, 401, "the old password no longer works");
  assert.equal((await login("test-admin", NEW)).status, 200, "the new one does");
  assert.equal(await db().collection("users").countDocuments(), usersBefore, "no duplicate admin");
  assert.equal(await db().collection("users").countDocuments({ username: "test-admin" }), 1);
  const stored = await db().collection("users").findOne({ username: "test-admin" });
  assert.ok(stored.passwordHash.startsWith("scrypt$") || !stored.passwordHash.includes(NEW), "stored as a hash");
  assert.equal((await login("test-staff", TEST_PASSWORD)).status, 200, "other users untouched");
});
