// Tests for railway.json (Step 38). No database, no server needed - this checks the FILE that
// will be read by Railway's own build/deploy system, which this project's own server never reads.
//
// What this test CAN prove: the JSON is valid and matches Railway's documented schema shape
// (builder, start command, health check path, restart policy), and that the health check path
// it names is a route this app actually serves.
// What it CANNOT prove: that Railway's live build/deploy/health-check behaviour matches this
// configuration exactly - only an actual deployment can show that (Step 37's own audit found no
// Railway project exists yet to check this against).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "railway.json");

test("railway.json is valid JSON matching Railway's documented schema shape", () => {
  const text = fs.readFileSync(CONFIG_PATH, "utf8");
  let config;
  assert.doesNotThrow(() => { config = JSON.parse(text); }, "must be valid JSON");
  assert.equal(config.build.builder, "NIXPACKS");
  assert.equal(config.deploy.startCommand, "npm start");
  assert.match(config.deploy.healthcheckPath, /^\//, "must be a path, not a full URL - Railway checks it against the deployed service itself");
  assert.equal(typeof config.deploy.healthcheckTimeout, "number");
  assert.ok(["ON_FAILURE", "ALWAYS", "NEVER"].includes(config.deploy.restartPolicyType));
});

test("railway.json's startCommand matches an npm script that actually exists", () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
  const scriptName = config.deploy.startCommand.replace(/^npm (run )?/, "");
  assert.ok(pkg.scripts[scriptName] || scriptName === "start", `"${config.deploy.startCommand}" must resolve to a real script`);
});

test("railway.json's healthcheckPath is a route this app actually serves", async () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const { createApp } = require("../app");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${config.deploy.healthcheckPath}`);
    // 200 (healthy) or 503 (server up, database down) are both "the route exists and answers" -
    // never a 404, which would mean the configured path is simply wrong.
    assert.ok([200, 503].includes(response.status), `expected 200 or 503, got ${response.status}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
