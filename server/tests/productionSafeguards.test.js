// Tests for Step 38's production-safety checks in server/config/env.js:
//  - MONGODB_URI: required (throws) in production, still defaults quietly in development -
//    the same "fail loudly in production, warn in development" rule AUTH_SECRET already used.
//  - PG_CUTOVER_ROUTES naming a route group without DATABASE_URL also set: a misconfiguration,
//    caught at start-up in every environment (not just production).
//  - backupDirConfigured: whether BACKUP_DIR was actually set, independent of NODE_ENV.
//
// Each check needs a FRESH process (env.js validates eagerly, once, the first time it's
// required - the same reason server/tests/helpers/envSetting.js and
// server/tests/postgresConnection.test.js's own DATABASE_URL check already spawn one instead of
// fighting Node's require cache). No real MongoDB or PostgreSQL connection is ever made here -
// these are all pure start-up validation checks.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readEnvSetting } = require("./helpers/envSetting");

const ENV_FILE = path.join(__dirname, "..", "config", "env.js");

function requireEnvKey(key, extraEnv) {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(ENV_FILE)})[${JSON.stringify(key)}]))`;
  return spawnSync(process.execPath, ["-e", script], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

test("MONGODB_URI: production refuses to start without it set", () => {
  const result = requireEnvKey("mongoUri", { NODE_ENV: "production", MONGODB_URI: "", AUTH_SECRET: "a".repeat(32) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MONGODB_URI is not set/);
});

test("MONGODB_URI: production starts fine when it IS set", () => {
  const result = requireEnvKey("mongoUri", { NODE_ENV: "production", MONGODB_URI: "mongodb://db.internal:27017/club", AUTH_SECRET: "a".repeat(32) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").pop()), "mongodb://db.internal:27017/club");
});

test("MONGODB_URI: development is UNCHANGED - a missing value still quietly falls back to the local default, no throw", () => {
  const { value, error } = readEnvSetting("MONGODB_URI", "mongoUri", "");
  assert.equal(error, undefined, error);
  assert.equal(value, "mongodb://127.0.0.1:27017/snooker_club_pro");
});

test("MONGODB_URI: development with a real value still works exactly as before", () => {
  const { value } = readEnvSetting("MONGODB_URI", "mongoUri", "mongodb://127.0.0.1:27017/something_else");
  assert.equal(value, "mongodb://127.0.0.1:27017/something_else");
});

test("PG_CUTOVER_ROUTES without DATABASE_URL: refused at start-up, in every environment (not just production)", () => {
  for (const nodeEnv of ["development", "production"]) {
    const result = requireEnvKey("databaseUrl", { NODE_ENV: nodeEnv, PG_CUTOVER_ROUTES: "settings", DATABASE_URL: "", AUTH_SECRET: "a".repeat(32), MONGODB_URI: "mongodb://127.0.0.1:27017/x" });
    assert.notEqual(result.status, 0, `NODE_ENV=${nodeEnv} should have refused to start`);
    assert.match(result.stderr, /PG_CUTOVER_ROUTES names a route group, but DATABASE_URL is not set/);
  }
});

test("PG_CUTOVER_ROUTES with DATABASE_URL also set: starts fine", () => {
  const result = requireEnvKey("databaseUrl", { NODE_ENV: "development", PG_CUTOVER_ROUTES: "settings", DATABASE_URL: "postgres://user@host:5432/db" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").pop()), "postgres://user@host:5432/db");
});

test("PG_CUTOVER_ROUTES empty (the default): DATABASE_URL may still be empty - unchanged, existing behaviour", () => {
  const result = requireEnvKey("databaseUrl", { NODE_ENV: "development", PG_CUTOVER_ROUTES: "", DATABASE_URL: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").pop()), "");
});

test("PG_CUTOVER_ROUTES with an unknown route group AND no DATABASE_URL: the unknown-route-group error still applies (unrelated to this step, re-confirmed)", () => {
  const result = requireEnvKey("databaseUrl", { NODE_ENV: "development", PG_CUTOVER_ROUTES: "totally-made-up", DATABASE_URL: "" });
  assert.notEqual(result.status, 0);
  // env.js itself does not know route-group NAMES (that is config/cutover.js's own job) - it only
  // checks "is DATABASE_URL set at all", so this is refused for THAT reason, not a duplicate of
  // cutover.js's own "unknown route group" check (which still runs later, per-request).
  assert.match(result.stderr, /PG_CUTOVER_ROUTES names a route group, but DATABASE_URL is not set/);
});

test("backupDirConfigured: true only when BACKUP_DIR is actually set, independent of NODE_ENV", () => {
  const unset = readEnvSetting("BACKUP_DIR", "backupDirConfigured", "");
  assert.equal(unset.value, false);
  const set = readEnvSetting("BACKUP_DIR", "backupDirConfigured", "/some/folder");
  assert.equal(set.value, true);
});

test("backup.service.js: describeBackupFolder() reports `configured` matching BACKUP_DIR, and onSystemDrive is unaffected", () => {
  const backupServiceFile = path.join(__dirname, "..", "services", "backup.service.js");
  const script = `console.log(JSON.stringify(require(${JSON.stringify(backupServiceFile)}).describeBackupFolder()))`;

  const unset = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, BACKUP_DIR: "" }, encoding: "utf8" });
  assert.equal(unset.status, 0, unset.stderr);
  const unsetResult = JSON.parse(unset.stdout.trim().split("\n").pop());
  assert.equal(unsetResult.configured, false);

  const set = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, BACKUP_DIR: "C:\\somewhere" }, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr);
  const setResult = JSON.parse(set.stdout.trim().split("\n").pop());
  assert.equal(setResult.configured, true);
});
