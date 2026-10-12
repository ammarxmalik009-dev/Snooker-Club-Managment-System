// Tests for GET /api/auth/page-access (Step 1.5: the client-side page-role guard).
// This endpoint is read-only and decides nothing by itself - it must always agree with the
// server's own pageGuard (middleware/auth.js), which is what actually protects a page when this
// app serves its own frontend. On a static host (Vercel) pageGuard never runs, so this endpoint is
// the browser's only way to ask "may I show this page?" - the data stays protected because every
// API endpoint still checks login (401) and role (403) on its own, regardless of this answer.
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs, TEST_PASSWORD } = require("./helpers/auth");
const { PAGE_PERMISSIONS, roleHasPermission } = require("../config/permissions");

const TEST_DB_URI = process.env.MONGODB_PAGEACCESS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_pageaccess";
const CLIENT_PAGES = path.join(__dirname, "..", "..", "client", "pages");
const ROLES = ["admin", "staff", "cashier"];

let server;
let baseUrl;
const cookies = {}; // role -> cookie

async function call(method, apiPath, { cookie, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (cookie) options.headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}/api${apiPath}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const pageAccess = (page, options) => call("GET", `/auth/page-access?page=${encodeURIComponent(page)}`, options);

// Fetches an actual page, exactly as pageGuard would decide (200 = served, 302 = refused/redirected)
async function fetchPage(page, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}${page}`, { headers, redirect: "manual" });
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
  for (const role of ROLES) cookies[role] = await loginAs(baseUrl, role);
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState === 1) await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------- Must be logged in ----------

test("no login, an expired/unknown cookie, and after logout -> 401 (same as every other API)", async () => {
  assert.equal((await pageAccess("/pages/dashboard.html")).status, 401);
  assert.equal((await pageAccess("/pages/dashboard.html", { cookie: "scp_session=not-a-real-token" })).status, 401);

  const cookie = await loginAs(baseUrl, "staff", "page-access-logout-test");
  await call("POST", "/auth/logout", { cookie });
  assert.equal((await pageAccess("/pages/dashboard.html", { cookie })).status, 401);
});

// ---------- Input validation (never a 500, never silently allowed) ----------

test("missing, duplicated or malformed 'page' -> 400 Invalid page address, nothing allowed", async () => {
  const cookie = cookies.admin;
  assert.equal((await pageAccess("", { cookie })).status, 400); // page=""
  for (const bad of ["/js/core/layout.js", "/api/tables", "/pages", "/pages/", "/pages/users", "/pages/users.htm",
    "/pages/../users.html", "not-a-page", "/pages/us%ers.html" /* bad % escape */]) {
    const response = await pageAccess(bad, { cookie });
    assert.equal(response.status, 400, bad);
    assert.equal(response.body.message, "Invalid page address", bad);
  }
  // a key given twice is refused by the shared singleQueryValues guard (Phase 11.8), same as every API
  const duplicate = await call("GET", "/auth/page-access?page=/pages/dashboard.html&page=/pages/users.html", { cookie });
  assert.equal(duplicate.status, 400);
});

// ---------- Different spellings of the same page agree with the canonical one ----------

test("case, URL-encoding and double slashes normalize to the same answer as pageGuard would give", async () => {
  for (const spelling of ["/pages/USERS.html", "/pages/users%2Ehtml", "/pages//users.html", "/PAGES/Users.HTML"]) {
    const response = await pageAccess(spelling, { cookie: cookies.cashier }); // cashier: users:manage is admin-only
    assert.equal(response.status, 200, spelling);
    assert.deepEqual(response.body.data, { page: "/pages/users.html", allowed: false }, spelling);
  }
  const admin = await pageAccess("/pages/Users.html", { cookie: cookies.admin });
  assert.deepEqual(admin.body.data, { page: "/pages/users.html", allowed: true });
});

// ---------- Source of truth: must always agree with pageGuard's own decision ----------

test("every page x every role: page-access 'allowed' matches exactly what pageGuard actually does", async () => {
  const pages = fs.readdirSync(CLIENT_PAGES).filter((file) => file.endsWith(".html"));
  assert.ok(pages.length >= 12, "all pages found");

  for (const file of pages) {
    const page = `/pages/${file}`;
    for (const role of ROLES) {
      const cookie = cookies[role];
      const { body } = await pageAccess(page, { cookie });
      const guardResponse = await fetchPage(page, cookie);
      const guardAllowed = guardResponse.status === 200;
      const guardDenied = guardResponse.status === 302 && guardResponse.headers.get("location") === "/pages/dashboard.html?denied=1";
      assert.ok(guardAllowed || guardDenied, `${page} (${role}): unexpected pageGuard status ${guardResponse.status}`);
      assert.equal(body.data.allowed, guardAllowed, `${page} (${role}): page-access said ${body.data.allowed}, pageGuard served=${guardAllowed}`);

      // Cross-check against the permissions map directly too (belt and suspenders)
      const needed = PAGE_PERMISSIONS[page];
      const expected = !needed || roleHasPermission(role, needed);
      assert.equal(body.data.allowed, expected, `${page} (${role}): disagrees with PAGE_PERMISSIONS`);
    }
  }
});

test("the login page itself is always 'allowed' (pageGuard never blocks it)", async () => {
  for (const role of ROLES) {
    const response = await pageAccess("/pages/login.html", { cookie: cookies[role] });
    assert.deepEqual(response.body.data, { page: "/pages/login.html", allowed: true }, role);
  }
});

// ---------- A page being "allowed" never bypasses an API's own, finer-grained role check ----------

test("'allowed' to see the café products page does not allow a cashier to manage products", async () => {
  const page = await pageAccess("/pages/products.html", { cookie: cookies.cashier });
  assert.equal(page.body.data.allowed, true, "cafe:view is open to every role");

  const list = await call("GET", "/products", { cookie: cookies.cashier });
  assert.equal(list.status, 200, "viewing products is allowed");

  const create = await call("POST", "/products", { cookie: cookies.cashier, headers: { "Content-Type": "application/json" } });
  assert.equal(create.status, 403, "creating a product needs products:manage (admin only)");
});

test("'allowed' to see the reports page does not survive to a cashier, who never gets one", async () => {
  const staffPage = await pageAccess("/pages/reports.html", { cookie: cookies.staff });
  assert.equal(staffPage.body.data.allowed, true);
  const staffApi = await call("GET", "/reports/revenue", { cookie: cookies.staff });
  assert.notEqual(staffApi.status, 403);

  const cashierPage = await pageAccess("/pages/reports.html", { cookie: cookies.cashier });
  assert.equal(cashierPage.body.data.allowed, false, "reports:view excludes cashier");
  const cashierApi = await call("GET", "/reports/revenue", { cookie: cookies.cashier });
  assert.equal(cashierApi.status, 403, "the API refuses it too, regardless of what the page says");
});
