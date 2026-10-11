// Tests for ALLOWED_ORIGINS and the origin check (deployment readiness, step 1.3).
//  - the setting is checked at start-up: only exact http(s)://host[:port] addresses, never a wildcard
//  - the app's own pages (Origin host = Host) work as before; other sites get 403
//  - pages on Vercel reach the API through a rewrite: Origin = the Vercel address, Host = the Railway
//    address. Only an exactly listed origin is allowed through.
//  - a missing Origin: allowed for scripts/tests, refused when the browser says another site sent it
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs, TEST_PASSWORD } = require("./helpers/auth");
const { readEnvSetting } = require("./helpers/envSetting");
const throttle = require("../services/loginThrottle");

const TEST_DB_URI = process.env.MONGODB_ORIGINS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_origins";
// Placeholders, not real addresses
const VERCEL = "https://club-placeholder.vercel.app";
const RAILWAY_HOST = "club-api-placeholder.up.railway.app";
const REFUSED = "Requests from other websites are not allowed.";

const readSetting = (value) => readEnvSetting("ALLOWED_ORIGINS", "allowedOrigins", value);

let apps = {};   // name -> { port, close }
let adminCookie;
let nextTable = 100;

async function startApp(options) {
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    port: server.address().port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// node:http (not fetch) so the test can set the Host header, like a proxy does
function call(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port: app.port,
      method,
      path: `/api${path}`,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null, headers: response.headers }));
    });
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

// A change that needs a login: create a table (201 when allowed)
const createTable = (app, headers) =>
  call(app, "POST", "/tables", { headers: { Cookie: adminCookie, ...headers }, body: { tableNumber: nextTable++, hourlyRate: 1 } });

const ownOrigin = (app) => `http://127.0.0.1:${app.port}`;

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  apps = {
    club: await startApp({ allowedOrigins: [] }),          // the default: club PC, nothing extra allowed
    hosted: await startApp({ allowedOrigins: [VERCEL] }),  // Railway with the Vercel address allowed
  };
  adminCookie = await loginAs(`http://127.0.0.1:${apps.club.port}`, "admin");
});

test.afterEach(() => throttle.clearAll());

test.after(async () => {
  for (const app of Object.values(apps)) await app.close();
  if (mongoose.connection.readyState === 1) await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------- The setting ----------

test("ALLOWED_ORIGINS: empty by default; exact addresses are stored as browsers send them", () => {
  assert.deepEqual(readSetting(""), { value: [] });
  assert.deepEqual(readSetting("  "), { value: [] });
  assert.deepEqual(readSetting(VERCEL), { value: [VERCEL] });
  assert.deepEqual(readSetting("https://Club.Example.com/ , http://localhost:3000"), { value: ["https://club.example.com", "http://localhost:3000"] });
  assert.deepEqual(readSetting("https://club.example.com:443"), { value: ["https://club.example.com"] }, "the default port is dropped");
});

test("ALLOWED_ORIGINS: wildcards, paths and other wrong values stop the start-up with a clear message", () => {
  for (const value of ["*", "https://*.vercel.app", "club.vercel.app", "https://club.vercel.app/pages", "https://club.vercel.app?x=1",
    "https://club.vercel.app#x", "https://user:pw@club.vercel.app", "ftp://club.vercel.app", "null", `${VERCEL},,http://localhost:3000`, `${VERCEL} http://x.example`]) {
    const result = readSetting(value);
    assert.ok(result.error, `"${value}" must be refused`);
    assert.match(result.error, /ALLOWED_ORIGINS must be a comma list of addresses like https:\/\/club\.example\.com \(no wildcard, no path\)/, value);
  }
});

// ---------- The club PC (default) ----------

test("club PC: the app's own pages (Origin host = Host) can change things, as before", async () => {
  assert.equal((await createTable(apps.club, { Origin: ownOrigin(apps.club) })).status, 201);
  assert.equal((await createTable(apps.hosted, { Origin: ownOrigin(apps.hosted) })).status, 201, "still works with ALLOWED_ORIGINS set");
});

test("club PC: another website is refused (403), reading is not affected", async () => {
  for (const origin of ["http://evil.example", VERCEL, `http://127.0.0.1:${apps.club.port + 1}`]) {
    const response = await createTable(apps.club, { Origin: origin });
    assert.equal(response.status, 403, origin);
    assert.equal(response.body.message, REFUSED);
  }
  const read = await call(apps.club, "GET", "/tables", { headers: { Cookie: adminCookie, Origin: "http://evil.example" } });
  assert.equal(read.status, 200, "GET changes nothing, so it isn't checked");
});

// ---------- Vercel -> Railway rewrite ----------

test("Vercel rewrite: the listed Vercel origin may change things although Host is the Railway address", async () => {
  const headers = { Host: RAILWAY_HOST, Origin: VERCEL, "X-Forwarded-Host": "club-placeholder.vercel.app" };
  assert.equal((await createTable(apps.hosted, headers)).status, 201);
  // the same request without ALLOWED_ORIGINS (today's behaviour) is refused - that is why the setting exists
  assert.equal((await createTable(apps.club, headers)).status, 403);
  // login through the rewrite works too
  const login = await call(apps.hosted, "POST", "/auth/login", { headers: { Host: RAILWAY_HOST, Origin: VERCEL }, body: { username: "test-admin", password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
});

test("Vercel rewrite: only the EXACT listed origin - look-alikes, other Vercel apps and http are refused", async () => {
  for (const origin of [
    "https://evil.vercel.app",
    "https://club-placeholder.vercel.app.evil.example",
    "https://evil-club-placeholder.vercel.app",
    "http://club-placeholder.vercel.app",
    "https://club-placeholder.vercel.app:8443",
    "https://CLUB-placeholder.vercel.app",
    `${VERCEL}/`,
    `${VERCEL}/pages/dashboard.html`,
  ]) {
    const response = await createTable(apps.hosted, { Host: RAILWAY_HOST, Origin: origin });
    assert.equal(response.status, 403, origin);
    assert.equal(response.body.message, REFUSED);
  }
});

test("Vercel rewrite: a faked X-Forwarded-Host can't make another site look like this one", async () => {
  const hostedTrusting = await startApp({ allowedOrigins: [VERCEL], trustProxy: 2 });
  try {
    const response = await createTable(hostedTrusting, { Host: RAILWAY_HOST, Origin: "https://evil.example", "X-Forwarded-Host": "evil.example" });
    assert.equal(response.status, 403);
  } finally {
    await hostedTrusting.close();
  }
});

// ---------- Missing and malformed Origin ----------

test("malformed Origin values are refused", async () => {
  for (const origin of ["null", "not a url", "file:///C:/club.html", "ftp://club-placeholder.vercel.app", "chrome-extension://abcdef", "https://"]) {
    const response = await createTable(apps.hosted, { Origin: origin });
    assert.equal(response.status, 403, origin);
  }
});

test("missing Origin: scripts and tests (no Sec-Fetch-Site) work; a browser request from another site is refused", async () => {
  assert.equal((await createTable(apps.club, {})).status, 201, "no Origin, no Sec-Fetch-Site (server-side script / test)");
  assert.equal((await createTable(apps.club, { "Sec-Fetch-Site": "same-origin" })).status, 201);
  assert.equal((await createTable(apps.club, { "Sec-Fetch-Site": "none" })).status, 201);
  for (const site of ["cross-site", "same-site", "Cross-Site"]) {
    const response = await createTable(apps.hosted, { "Sec-Fetch-Site": site });
    assert.equal(response.status, 403, site);
    assert.equal(response.body.message, REFUSED);
  }
});

// ---------- Login, permissions and the login lock are unchanged ----------

test("an allowed origin is not a login: no cookie -> 401, wrong role -> 403", async () => {
  const noLogin = await call(apps.hosted, "POST", "/tables", { headers: { Host: RAILWAY_HOST, Origin: VERCEL }, body: { tableNumber: nextTable++, hourlyRate: 1 } });
  assert.equal(noLogin.status, 401);
  const cashierCookie = await loginAs(`http://127.0.0.1:${apps.club.port}`, "cashier");
  // creating users is admin-only (users:manage)
  const cashier = await call(apps.hosted, "POST", "/users", { headers: { Host: RAILWAY_HOST, Origin: VERCEL, Cookie: cashierCookie }, body: { name: "Origin test", username: "origin-test", role: "staff", password: "Snooker-cue-2026" } });
  assert.equal(cashier.status, 403);
  assert.equal(cashier.body.message, "You don't have permission to do this.");
});

test("refused-origin logins never reach the login lock; the lock still works for allowed origins", async () => {
  for (let i = 0; i < throttle.LIMITS.ip + 5; i += 1) {
    const response = await call(apps.hosted, "POST", "/auth/login", { headers: { Origin: "https://evil.example" }, body: { username: "test-admin", password: "Wrong-password-9" } });
    assert.equal(response.status, 403);
  }
  const ok = await call(apps.hosted, "POST", "/auth/login", { headers: { Host: RAILWAY_HOST, Origin: VERCEL }, body: { username: "test-admin", password: TEST_PASSWORD } });
  assert.equal(ok.status, 200, "nothing was counted, nobody is locked");

  for (let i = 0; i < throttle.LIMITS.username; i += 1) {
    await call(apps.hosted, "POST", "/auth/login", { headers: { Host: RAILWAY_HOST, Origin: VERCEL }, body: { username: "test-admin", password: "Wrong-password-9" } });
  }
  const locked = await call(apps.hosted, "POST", "/auth/login", { headers: { Host: RAILWAY_HOST, Origin: VERCEL }, body: { username: "test-admin", password: TEST_PASSWORD } });
  assert.equal(locked.status, 429);
});
