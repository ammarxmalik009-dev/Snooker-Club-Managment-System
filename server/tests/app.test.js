// Automatic checks for the server foundation. Run with: npm test
// These tests start the app WITHOUT a database, on a random free port,
// and check routing, error handling and static files.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

let server;
let baseUrl;

test.before(async () => {
  server = createApp().listen(0); // port 0 = "any free port"
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections(); // don't wait for idle keep-alive connections
  return new Promise((resolve) => server.close(resolve));
});

test("GET /api/health reports 503 when the database is not connected", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.data.server, "running");
  assert.equal(body.data.database, "disconnected");
  assert.ok(!Number.isNaN(Date.parse(body.data.serverTime)));
});

test("API endpoints need a login: 401 JSON (unknown URLs too - existence isn't revealed)", async () => {
  // (With a login, unknown URLs return 404 - tested in auth.test.js)
  for (const path of ["/api/does-not-exist", "/api/tables", "/api/bills", "/api/settings", "/api/users"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { success: false, message: "Please log in to continue." }, path);
  }
});

test("invalid JSON body returns a JSON 400", async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ this is not json",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { success: false, message: "Request body is not valid JSON" });
});

test("home page redirects to the dashboard", async () => {
  const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/pages/dashboard.html");
});

test("login page and all page files are served with security headers", async () => {
  const page = await fetch(`${baseUrl}/pages/login.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Log in · Snooker Club Pro<\/title>/);
  assert.ok(page.headers.get("content-security-policy"), "Content-Security-Policy header missing");
  assert.doesNotMatch(page.headers.get("content-security-policy"), /upgrade-insecure-requests/);
  assert.equal(page.headers.get("x-powered-by"), null);

  // CSS and JavaScript are public (they contain no club data)
  for (const file of ["/css/theme.css", "/css/layout.css", "/css/components.css",
                      "/js/core/api.js", "/js/core/ui.js", "/js/core/layout.js", "/js/core/format.js",
                      "/js/pages/dashboard.js", "/js/pages/tables.js", "/js/core/sessions.js", "/js/pages/sessions.js",
                      "/js/core/billing.js", "/js/pages/billing.js", "/js/pages/settings.js",
                      "/js/pages/bookings.js", "/js/pages/customers.js", "/js/pages/login.js", "/js/pages/users.js",
                      "/js/pages/reports.js", "/vendor/chart.umd.min.js",
                      "/js/core/cafe.js", "/js/pages/products.js", "/js/pages/categories.js",
                      "/js/pages/players.js", "/js/core/matches.js"]) {
    const response = await fetch(baseUrl + file);
    assert.equal(response.status, 200, `${file} should be served`);
  }
});

test("app pages redirect to the login page when nobody is logged in", async () => {
  for (const page of ["dashboard", "tables", "sessions", "billing", "bookings", "customers", "settings", "users", "reports", "products", "categories", "players", "nope"]) {
    const response = await fetch(`${baseUrl}/pages/${page}.html`, { redirect: "manual" });
    assert.equal(response.status, 302, page);
    assert.equal(response.headers.get("location"), `/pages/login.html?next=%2Fpages%2F${page}.html`, page);
  }
});

test("unknown file outside /pages returns an HTML 404", async () => {
  const response = await fetch(`${baseUrl}/nope.html`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /text\/html/);
});
