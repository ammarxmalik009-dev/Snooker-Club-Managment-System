// Test helper: loads config/env.js in a fresh Node process with one setting, like a real start-up.
// Returns { value } (that setting as env.js read it) or { error } (the start-up error text).

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENV_FILE = path.join(__dirname, "..", "..", "config", "env.js");

function readEnvSetting(variable, key, value) {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(ENV_FILE)})[${JSON.stringify(key)}]))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, [variable]: value, NODE_ENV: "development" },
    encoding: "utf8",
  });
  if (result.status !== 0) return { error: result.stderr };
  return { value: JSON.parse(result.stdout.trim().split("\n").pop()) };
}

module.exports = { readEnvSetting };
