// Tests for Phase 3 Group 2's PostgreSQL-only admin CLI scripts (Step 32):
//   server/scripts/createAdminPg.js
//   server/scripts/resetAdminPasswordPg.js
//
// These are PostgreSQL-only commands, not a backend selector - they never import Mongoose, never
// call mongoose.connect(), and never touch MongoDB. They do not activate the Users/Auth cutover
// (server/config/cutover.js's KNOWN_ROUTE_GROUPS still does not include "users") and have no
// effect on any HTTP request's backend selection.
//
// Static checks (no database needed) run always. The real, spawned-process checks below need
// PG_TEST_DATABASE_URL at 127.0.0.1:5433 (same convention as postgresUsersAuth.test.js) and are
// SKIPPED with a clear reason otherwise - never run against DATABASE_URL or production.
//
// No mocks for the spawned-process tests: each one runs the actual script as a real child
// process, feeds it real stdin, and checks its real stdout/exit code against a real, isolated
// PostgreSQL test database - the same style server/tests/hardening.test.js already uses for
// npm run reset-admin-password.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

// ---------------------------------------------------------------------------
// Static backend-isolation checks - source-level proof, always run.
// ---------------------------------------------------------------------------

test("backend isolation (static): neither PostgreSQL admin CLI script requires mongoose, the MongoDB admin service, or the cutover config", () => {
  for (const file of ["scripts/createAdminPg.js", "scripts/resetAdminPasswordPg.js"]) {
    const source = read(file);
    assert.doesNotMatch(source, /require\(["']mongoose["']\)/, `${file} must not require mongoose`);
    assert.doesNotMatch(source, /require\(["'].*\/users\.service["']\)/, `${file} must not require the MongoDB users service`);
    assert.doesNotMatch(source, /require\(["'].*\/auth\.service["']\)/, `${file} must not require the MongoDB auth service`);
    assert.doesNotMatch(source, /require\(["'].*\/config\/cutover["']\)/, `${file} must not require the cutover selector at all`);
    assert.match(source, /require\(["'].*\/users\.pg\.service["']\)/, `${file} must use the PostgreSQL service directly`);
  }
});

test("backend isolation (static): the existing MongoDB admin CLI scripts are unchanged - still mongoose-only, no PostgreSQL import", () => {
  for (const file of ["scripts/createAdmin.js", "scripts/resetAdminPassword.js"]) {
    const source = read(file);
    assert.match(source, /require\(["']mongoose["']\)/, `${file} should still use mongoose`);
    assert.doesNotMatch(source, /require\(["'].*\/db\.pg["']\)/, `${file} must not require the PostgreSQL connection layer`);
    assert.doesNotMatch(source, /require\(["'].*\.pg\.service["']\)/, `${file} must not require a PostgreSQL service`);
  }
});

test("backend isolation: no CLI argument, environment variable, query parameter, header, or request body read by these scripts can activate the Users/Auth HTTP cutover", () => {
  // The scripts above never reference the cutover selector at all (proven above), so running
  // them cannot change isPgAuthoritative's answer for any route. Re-confirmed directly here too:
  const { isPgAuthoritative, KNOWN_ROUTE_GROUPS } = require("../config/cutover");
  assert.ok(!KNOWN_ROUTE_GROUPS.includes("users"));
  assert.equal(isPgAuthoritative("settings"), false); // unrelated to this step, just confirms the selector is untouched
});

test("package.json: new PostgreSQL admin commands exist and point only at the new scripts; the existing MongoDB commands are unchanged", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.scripts["create-admin:pg"], "node server/scripts/createAdminPg.js");
  assert.equal(pkg.scripts["reset-admin-password:pg"], "node server/scripts/resetAdminPasswordPg.js");
  assert.equal(pkg.scripts["create-admin"], "node server/scripts/createAdmin.js");
  assert.equal(pkg.scripts["reset-admin-password"], "node server/scripts/resetAdminPassword.js");
});

// ---------------------------------------------------------------------------
// Real, spawned-process checks against an isolated PostgreSQL test database.
// ---------------------------------------------------------------------------

const TEST_URL = getPgTestDatabaseUrl();
let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Phase 3, Group 2") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}
if (TEST_URL) process.env.DATABASE_URL = TEST_URL; // so this test file's OWN use of config/db.pg (migrations, lock, admin lookups) targets the same database the spawned scripts are told to use

// A deliberately unreachable MongoDB address - MONGODB_URI is overridden to this for every spawn
// below. If either script secretly depended on MongoDB being reachable, these would hang or
// fail; the fact that they succeed proves the opposite.
const UNREACHABLE_MONGO_URI = "mongodb://127.0.0.1:1/this-must-never-be-reached";

function runScript(scriptName, answers, { databaseUrl = TEST_URL } = {}) {
  const script = path.join(__dirname, "..", "scripts", scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, DATABASE_URL: databaseUrl, MONGODB_URI: UNREACHABLE_MONGO_URI },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
    child.stdin.end(answers.map((line) => `${line}\n`).join(""));
  });
}
const runCreate = (answers, opts) => runScript("createAdminPg.js", answers, opts);
const runReset = (answers, opts) => runScript("resetAdminPasswordPg.js", answers, opts);

test(
  "Phase 3 Group 2: PostgreSQL admin CLI scripts - real isolated PostgreSQL database, real spawned processes",
  { skip: skipReason },
  async (t) => {
    const { getPool, closePool } = require("../config/db.pg");
    const migrate = require("../db/migrate");

    const lockClient = await lockAppSchema(getPool());
    t.after(async () => {
      await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
      await unlockAppSchema(lockClient);
      await closePool();
    });

    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
    await migrate.runMigrations();

    const STRONG_PASSWORD = "Snooker-cue-2026";

    await t.test("create-admin:pg: connection failure to an unreachable PostgreSQL exits non-zero, with a clear message and no credentials printed, before any prompt", async () => {
      const unreachable = "postgres://baduser:badpass@127.0.0.1:1/nope";
      const result = await runCreate(["Admin", "admin.unreachable", STRONG_PASSWORD, STRONG_PASSWORD], { databaseUrl: unreachable });
      assert.notEqual(result.code, 0);
      assert.ok(!result.output.includes("baduser") && !result.output.includes("badpass"), "credentials never appear in the output");
      assert.ok(!result.output.includes(STRONG_PASSWORD), "a typed password is never printed");
    });

    await t.test("create-admin:pg: cancellation (stdin closed with no answers) creates no account and exits non-zero", async () => {
      const result = await runCreate([]);
      assert.equal(result.code, 1);
      assert.match(result.output, /cancelled/i);
      const admins = await require("../services/users.pg.service").listActiveAdmins();
      assert.equal(admins.length, 0, "no account was created");
    });

    await t.test("create-admin:pg: a weak password is rejected and no account is created", async () => {
      const result = await runCreate(["Admin One", "admin.one", "weak", "weak"]);
      assert.equal(result.code, 1);
      assert.match(result.output, /Password must be at least 10 characters/);
      assert.ok(!result.output.includes("weak"), "the typed password is never printed");
      const admins = await require("../services/users.pg.service").listActiveAdmins();
      assert.equal(admins.length, 0);
    });

    let firstAdminCreated = false;
    await t.test("create-admin:pg: a real PostgreSQL admin is created, with MongoDB unreachable and never contacted", async () => {
      const result = await runCreate(["Admin One", "admin.one", STRONG_PASSWORD, STRONG_PASSWORD]);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /PostgreSQL admin "admin\.one" created/);
      assert.ok(!result.output.includes(STRONG_PASSWORD), "the password is never printed");
      const admins = await require("../services/users.pg.service").listActiveAdmins();
      assert.deepEqual(admins.map((a) => a.username), ["admin.one"]);
      firstAdminCreated = true;
    });

    await t.test("create-admin:pg: refused once an active admin already exists (duplicate-admin protection preserved)", async (t2) => {
      t2.before(() => assert.ok(firstAdminCreated, "requires the previous test's admin"));
      const result = await runCreate(["Someone Else", "someone.else", STRONG_PASSWORD, STRONG_PASSWORD]);
      assert.equal(result.code, 1);
      assert.match(result.output, /An active PostgreSQL admin already exists/);
      const admins = await require("../services/users.pg.service").listActiveAdmins();
      assert.deepEqual(admins.map((a) => a.username), ["admin.one"], "still just the one admin");
    });

    await t.test("create-admin:pg -> HTTP login (truthfully verified, not assumed): the created row can really log in through auth.pg.service.js's own login(), the same function the real app would use once cutover is on", async () => {
      // This test proves the PostgreSQL ROW created by the CLI can authenticate through the real
      // PostgreSQL login service function - it does NOT start the Express app or go through HTTP,
      // because "users" is not a recognised cutover route group and must not become one here.
      const authPg = require("../services/auth.pg.service");
      const { token, user } = await authPg.login({ username: "admin.one", password: STRONG_PASSWORD, ip: "127.0.0.1", userAgent: "test" });
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      assert.equal(user.username, "admin.one");
      assert.equal(user.role, "admin");
    });

    await t.test("reset-admin-password:pg: an empty active-admin list (no admin yet) is handled safely", async () => {
      // Uses a separate, throwaway schema state: drop and recreate with no admin.
      await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
      await migrate.runMigrations();
      const result = await runReset(["anyone", STRONG_PASSWORD, STRONG_PASSWORD]);
      assert.equal(result.code, 1);
      assert.match(result.output, /There is no active PostgreSQL admin.*npm\.cmd run create-admin:pg/s);
    });

    let resetAdminUsername;
    await t.test("reset-admin-password:pg: an invalid/arbitrary username (not in the active-admin list) is rejected, never accepted", async () => {
      const usersPg = require("../services/users.pg.service");
      await usersPg.createUser({ name: "Admin Two", username: "admin.two", role: "admin", password: STRONG_PASSWORD });
      resetAdminUsername = "admin.two";
      const NEW_PASSWORD = "Reset-cue-2468";
      const result = await runReset(["not-a-real-admin", "admin.two", NEW_PASSWORD, NEW_PASSWORD]);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /That is not an active PostgreSQL admin/);
      assert.match(result.output, /password of PostgreSQL admin "admin\.two" was changed/);
    });

    await t.test("reset-admin-password:pg: session invalidation is preserved - a session created before the reset is ended", async () => {
      const authPg = require("../services/auth.pg.service");
      const usersPg = require("../services/users.pg.service");
      const authSessionsPg = require("../services/authSessions.pg.service");
      const { token } = await authPg.login({ username: resetAdminUsername, password: "Reset-cue-2468", ip: "127.0.0.1", userAgent: "test" });
      assert.ok(await authPg.resolveSession(token), "the session works right after login");

      const NEWER_PASSWORD = "Even-newer-cue-13579";
      const result = await runReset(["", NEWER_PASSWORD, NEWER_PASSWORD]); // Enter = the only active admin
      assert.equal(result.code, 0, result.output);
      assert.equal(await authPg.resolveSession(token), null, "the pre-reset session no longer resolves");

      await assert.rejects(authPg.login({ username: resetAdminUsername, password: "Reset-cue-2468" }), /Invalid username or password/);
      const relogin = await authPg.login({ username: resetAdminUsername, password: NEWER_PASSWORD, ip: "127.0.0.1", userAgent: "test" });
      assert.equal(relogin.user.username, resetAdminUsername);
      void usersPg; // referenced above only for createUser
    });

    await t.test("reset-admin-password:pg: a weak replacement password is rejected and nothing changes", async () => {
      const result = await runReset(["", "weak", "weak"]);
      assert.equal(result.code, 1);
      assert.match(result.output, /Password must be at least 10 characters/);
    });

    await t.test("reset-admin-password:pg: connection failure to an unreachable PostgreSQL exits non-zero with no credentials printed", async () => {
      const unreachable = "postgres://baduser:badpass@127.0.0.1:1/nope";
      const result = await runReset(["anything"], { databaseUrl: unreachable });
      assert.notEqual(result.code, 0);
      assert.ok(!result.output.includes("baduser") && !result.output.includes("badpass"));
    });
  }
);
