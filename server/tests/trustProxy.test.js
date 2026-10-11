// Tests for TRUST_PROXY (deployment readiness, step 1.2): which IP the app sees as the visitor's.
//  - the setting is checked at start-up: only false, 1-5 proxies or a list of proxy addresses
//  - off (the club PC): X-Forwarded-For is ignored, so a visitor can't fake an IP to dodge the login lock
//  - on (behind a hosting proxy): the real visitor IP is used, so one visitor's lock doesn't lock everyone
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs, TEST_PASSWORD } = require("./helpers/auth");
const { readEnvSetting } = require("./helpers/envSetting");
const throttle = require("../services/loginThrottle");

const TEST_DB_URI = process.env.MONGODB_PROXY_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_proxy";

// Loads config/env.js in a fresh Node process with this TRUST_PROXY, like a real start-up
const readSetting = (value) => readEnvSetting("TRUST_PROXY", "trustProxy", value);

// Starts the app with a trust proxy setting; returns { baseUrl, close }
async function startApp(trustProxy) {
  const server = createApp({ trustProxy }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function login(baseUrl, username, password, forwardedFor) {
  const headers = { "Content-Type": "application/json" };
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ username, password }) });
  return response.status;
}

// The IP stored with the newest login session = the req.ip the app saw
async function lastLoginIp() {
  const [session] = await mongoose.connection.collection("authsessions").find().sort({ _id: -1 }).limit(1).toArray();
  return session.ip;
}

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  // create the test user once (through the real login endpoint)
  const app = await startApp(false);
  await loginAs(app.baseUrl, "staff");
  await app.close();
});

test.afterEach(() => throttle.clearAll());

test.after(async () => {
  if (mongoose.connection.readyState === 1) await dropTestDatabase();
  await mongoose.disconnect();
});

// ---------- The setting ----------

test("TRUST_PROXY: empty, false and 0 mean no proxy (the default)", () => {
  for (const value of ["", "false", "FALSE", "0", " "]) assert.deepEqual(readSetting(value), { value: false }, `"${value}"`);
});

test("TRUST_PROXY: a number of proxies (1-5) or a list of proxy addresses", () => {
  assert.deepEqual(readSetting("1"), { value: 1 });
  assert.deepEqual(readSetting(" 2 "), { value: 2 });
  assert.deepEqual(readSetting("loopback"), { value: ["loopback"] });
  assert.deepEqual(readSetting("10.0.0.0/8, 192.168.1.5,fd00::/8,uniquelocal"), { value: ["10.0.0.0/8", "192.168.1.5", "fd00::/8", "uniquelocal"] });
});

test("TRUST_PROXY: 'true' (trust everyone) and wrong values stop the start-up with a clear message", () => {
  for (const value of ["true", "yes", "6", "-1", "1.5", "10.0.0.0/33", "300.1.1.1", "10.0.0.1/8/1", "loopback,", "*"]) {
    const result = readSetting(value);
    assert.ok(result.error, `"${value}" must be refused`);
    assert.match(result.error, /TRUST_PROXY must be empty, false, a number of proxies from 1 to 5, or a comma list of proxy addresses/, value);
  }
});

// ---------- req.ip as the app sees it ----------

test("off (club PC): X-Forwarded-For is ignored, req.ip is the direct connection", async () => {
  const app = await startApp(false);
  try {
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "203.0.113.7"), 200);
    assert.match(await lastLoginIp(), /^(::ffff:)?127\.0\.0\.1$/);
  } finally {
    await app.close();
  }
});

test("on (1 proxy): req.ip is the visitor IP the proxy added - not one a visitor typed in front of it", async () => {
  const app = await startApp(1);
  try {
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "203.0.113.7"), 200);
    assert.equal(await lastLoginIp(), "203.0.113.7");
    // the visitor sent "1.2.3.4", the proxy appended the real address: only the proxy's entry counts
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "1.2.3.4, 198.51.100.20"), 200);
    assert.equal(await lastLoginIp(), "198.51.100.20");
  } finally {
    await app.close();
  }
});

// ---------- The login lock still works ----------

test("off: a faked X-Forwarded-For can't dodge the IP lock", async () => {
  const app = await startApp(false);
  try {
    for (let i = 0; i < throttle.LIMITS.ip; i += 1) {
      assert.equal(await login(app.baseUrl, `ghost-${i}`, "Wrong-password-9", `203.0.113.${i}`), 401);
    }
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "198.51.100.99"), 429, "the one real IP is locked");
  } finally {
    await app.close();
  }
});

test("on: one visitor's failed logins lock only that visitor, not everyone behind the proxy", async () => {
  const app = await startApp(1);
  try {
    for (let i = 0; i < throttle.LIMITS.ip; i += 1) {
      assert.equal(await login(app.baseUrl, `ghost-${i}`, "Wrong-password-9", "203.0.113.50"), 401);
    }
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "203.0.113.50"), 429, "the guessing visitor is locked");
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "198.51.100.8"), 200, "another visitor can still log in");
    // the username lock (5 failures) still works too
    for (let i = 0; i < throttle.LIMITS.username; i += 1) await login(app.baseUrl, "test-staff", "Wrong-password-9", `192.0.2.${i}`);
    assert.equal(await login(app.baseUrl, "test-staff", TEST_PASSWORD, "192.0.2.200"), 429, "the username is locked from any IP");
  } finally {
    await app.close();
  }
});
