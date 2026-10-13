// Test helper: loads config/env.js in a fresh Node process with one setting, like a real start-up.
// Returns { value } (that setting as env.js read it) or { error } (the start-up error text).

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENV_FILE = path.join(__dirname, "..", "..", "config", "env.js");

// extraEnv (Step 38): additional env vars for this one fresh process, e.g. { NODE_ENV: "production" }
// to check a production-only validation rule - without it, every call still defaults to the
// original "development" behaviour every existing caller already relies on.
function readEnvSetting(variable, key, value, extraEnv = {}) {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(ENV_FILE)})[${JSON.stringify(key)}]))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, [variable]: value, NODE_ENV: "development", ...extraEnv },
    encoding: "utf8",
  });
  if (result.status !== 0) return { error: result.stderr };
  return { value: JSON.parse(result.stdout.trim().split("\n").pop()) };
}

module.exports = { readEnvSetting };
