// Tests for Phase 3's PostgreSQL backup/restore readiness (Step 35):
//   server/scripts/backupPostgres.js
//   server/scripts/restorePostgresBackup.js
//
// These are PostgreSQL-only commands, never touching MongoDB and never changing the Users/Auth
// cutover selector (server/config/cutover.js's KNOWN_ROUTE_GROUPS is untouched by this step).
//
// Static checks (no external tool needed) run always. The real, spawned-process checks need
// BOTH PG_TEST_DATABASE_URL (this project's own convention, 127.0.0.1:5433) AND a working
// pg_dump/pg_restore (via PG_DUMP_PATH/PG_RESTORE_PATH, or already on PATH) - SKIPPED with a
// clear reason if either is missing, never faked.
//
// No mocks for the spawned-process tests: each one runs the actual script as a real child
// process against a real, isolated PostgreSQL test database, and a second, throwaway recovery
// database created and dropped by this file - the same "real tool, real isolated database"
// standard every other PostgreSQL integration test in this project already holds to.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

// ---------------------------------------------------------------------------
// Static checks - always run.
// ---------------------------------------------------------------------------

test("backup/restore isolation (static): neither PostgreSQL script requires mongoose or touches the cutover selector", () => {
  for (const file of ["scripts/backupPostgres.js", "scripts/restorePostgresBackup.js"]) {
    const source = read(file);
    assert.doesNotMatch(source, /require\(["']mongoose["']\)/, `${file} must not require mongoose`);
    assert.doesNotMatch(source, /require\(["'].*\/config\/cutover["']\)/, `${file} must not require the cutover selector`);
  }
});

test("package.json: new PostgreSQL backup/restore commands exist, and existing MongoDB backup commands are unchanged", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.scripts["backup:pg"], "node server/scripts/backupPostgres.js");
  assert.equal(pkg.scripts["restore-backup:pg"], "node server/scripts/restorePostgresBackup.js");
  assert.equal(pkg.scripts["restore-backup"], "node server/scripts/restoreBackup.js");
});

// ---------------------------------------------------------------------------
// Real, spawned-process checks against real isolated PostgreSQL databases.
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
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

const PG_DUMP = process.env.PG_DUMP_PATH || "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE_PATH || "pg_restore";

async function toolsAvailable() {
  const dump = await run(PG_DUMP, ["--version"]);
  const restore = await run(PG_RESTORE, ["--version"]);
  return dump.code === 0 && restore.code === 0;
}

test(
  "Phase 3 (Step 35): PostgreSQL backup & restore - real isolated databases, real pg_dump/pg_restore, real spawned scripts",
  { skip: skipReason },
  async (t) => {
    if (!(await toolsAvailable())) {
      t.skip(`pg_dump/pg_restore not found (tried "${PG_DUMP}"/"${PG_RESTORE}") - set PG_DUMP_PATH/PG_RESTORE_PATH to their full paths, or install the PostgreSQL 18 client tools`);
      return;
    }

    const { getPool, closePool } = require("../config/db.pg");
    const migrate = require("../db/migrate");
    const usersPg = require("../services/users.pg.service");
    const authPg = require("../services/auth.pg.service");

    const lockClient = await lockAppSchema(getPool());
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scp-pg-backup-test-"));
    const sourceUrl = new URL(TEST_URL);
    const recoveryDbName = "snooker_club_pro_test_pgbackuprestore";
    const maintenanceUrl = new URL(TEST_URL);
    maintenanceUrl.pathname = "/postgres";
    const recoveryUrl = new URL(TEST_URL);
    recoveryUrl.pathname = `/${recoveryDbName}`;

    async function dropRecoveryDb() {
      const pool = new Pool({ connectionString: maintenanceUrl.toString() });
      try {
        await pool.query(`DROP DATABASE IF EXISTS ${recoveryDbName}`);
      } finally {
        await pool.end();
      }
    }
    async function createRecoveryDb() {
      await dropRecoveryDb();
      const pool = new Pool({ connectionString: maintenanceUrl.toString() });
      try {
        await pool.query(`CREATE DATABASE ${recoveryDbName}`);
      } finally {
        await pool.end();
      }
    }
    async function recoveryRowCount(table) {
      const pool = new Pool({ connectionString: recoveryUrl.toString() });
      try {
        const result = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
        return result.rows[0].n;
      } finally {
        await pool.end();
      }
    }

    t.after(async () => {
      await dropRecoveryDb().catch(() => {});
      fs.rmSync(backupRoot, { recursive: true, force: true });
      await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
      await unlockAppSchema(lockClient);
      await closePool();
    });

    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
    await migrate.runMigrations();
    const STRONG_PASSWORD = "Snooker-cue-backup-2026";
    await usersPg.createFirstAdmin({ name: "Backup Admin", username: "backup.admin", password: STRONG_PASSWORD });
    const { token } = await authPg.login({ username: "backup.admin", password: STRONG_PASSWORD, ip: "127.0.0.1", userAgent: "test" });
    assert.ok(await authPg.resolveSession(token), "a real session exists before any backup/restore");

    const scriptEnv = {
      ...process.env,
      DATABASE_URL: sourceUrl.toString(),
      BACKUP_DIR: backupRoot,
      PG_DUMP_PATH: PG_DUMP,
      PG_RESTORE_PATH: PG_RESTORE,
      MONGODB_URI: "mongodb://127.0.0.1:1/this-must-never-be-reached",
    };

    let backupFile, manifestPath, manifest;

    await t.test("backup:pg: makes a verified backup with a manifest, excluding session data", async () => {
      const result = await run(process.execPath, [path.join(__dirname, "..", "scripts", "backupPostgres.js")], { env: scriptEnv });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Backup verified and saved/);
      const folder = path.join(backupRoot, "postgres");
      const files = fs.readdirSync(folder).filter((name) => name.endsWith(".dump"));
      assert.equal(files.length, 1);
      backupFile = path.join(folder, files[0]);
      manifestPath = `${backupFile}.manifest.json`;
      assert.ok(fs.existsSync(manifestPath), "a manifest is written alongside the dump");
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.tables["app.users"], 1);
      assert.ok(!("app.auth_sessions" in manifest.tables), "session data is never part of the manifest's row counts");
      void sourceUrl; // the local test database uses trust auth (no password) - credential redaction is exercised below, against a URL that has one
    });

    await t.test("backup:pg: an unreachable DATABASE_URL fails clearly, leaves no dump file behind, and prints no credentials", async () => {
      const badEnv = { ...scriptEnv, DATABASE_URL: "postgres://baduser:badpass@127.0.0.1:1/nope", BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "scp-pg-backup-bad-")) };
      const result = await run(process.execPath, [path.join(__dirname, "..", "scripts", "backupPostgres.js")], { env: badEnv });
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes("baduser") && !result.stdout.includes("badpass"));
      assert.ok(!result.stderr.includes("baduser") && !result.stderr.includes("badpass"));
      const folder = path.join(badEnv.BACKUP_DIR, "postgres");
      const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
      assert.equal(files.filter((name) => name.endsWith(".dump")).length, 0, "no half-made backup file is left behind");
      fs.rmSync(badEnv.BACKUP_DIR, { recursive: true, force: true });
    });

    await t.test("restore-backup:pg: with no --file, lists the available backups and changes nothing", async () => {
      const result = await run(process.execPath, [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js")], { env: scriptEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Backup folder/);
      assert.match(result.stdout, new RegExp(path.basename(backupFile)));
    });

    await t.test("restore-backup:pg: with --file but no --target, refuses - there is no default target", async () => {
      const result = await run(process.execPath, [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`], { env: scriptEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /target is required/);
    });

    await t.test("restore-backup:pg: cancelling the first confirmation changes nothing", async () => {
      await createRecoveryDb();
      const result = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv, input: "no\n" }
      );
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Cancelled\. Nothing was changed/);
    });

    await t.test("restore-backup:pg: restores into a fresh, isolated recovery database and verifies row counts against the manifest", async () => {
      const result = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv, input: "RESTORE\n" }
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Restore verified: every table's row count matches/);
      assert.equal(await recoveryRowCount("app.users"), 1);
      assert.equal(await recoveryRowCount("app.auth_sessions"), 0, "session data is never restored - the restore always ends every session");
    });

    await t.test("restore-backup:pg: restoring again into the now-populated recovery database requires the SECOND, differently-worded confirmation", async () => {
      const refused = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv, input: "RESTORE\nnot the right phrase\n" }
      );
      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /OVERWRITE EXISTING DATA/);
      assert.match(refused.stdout, /Cancelled\. Nothing was changed/);
      assert.equal(await recoveryRowCount("app.users"), 1, "the earlier restore's data is untouched by the cancelled attempt");

      const accepted = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv, input: "RESTORE\nOVERWRITE EXISTING DATA\n" }
      );
      assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
      assert.match(accepted.stdout, /Restore verified: every table's row count matches/);
      assert.equal(await recoveryRowCount("app.users"), 1, "restoring again (idempotent) still ends with exactly the backup's own counts");
    });

    await t.test("restore-backup:pg: a third consecutive restore against the same target still succeeds (the migration-tracking table is never wiped by this script)", async () => {
      const result = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv, input: "RESTORE\nOVERWRITE EXISTING DATA\n" }
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
    });

    await t.test("restore-backup:pg: a missing backup file is refused cleanly", async () => {
      const result = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${backupFile}.does-not-exist`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv }
      );
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /not found/);
    });

    await t.test("restore-backup:pg: a backup file with no manifest next to it is refused, never restored blindly", async () => {
      const orphanFile = `${backupFile}.orphan-copy`;
      fs.copyFileSync(backupFile, orphanFile);
      const result = await run(
        process.execPath,
        [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${orphanFile}`, `--target=${recoveryUrl.toString()}`],
        { env: scriptEnv }
      );
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /No manifest found/);
      fs.rmSync(orphanFile);
    });

    await t.test(
      "Step 36: backup and restore both work for a non-superuser role that owns its own schema, including a genuinely circular foreign-key pair, WITHOUT --disable-triggers",
      async (t2) => {
        // A role shaped like a typical managed-database app role: not a superuser, but owns its
        // own database (so it has full DDL/DML rights within it - confirmed below, not assumed).
        // This is the realistic case Step 36's own audit was asked to check: whether this
        // project's restore design needs more than "ordinary managed-database privileges".
        const roleName = "scp_step36_test_role";
        const rolePassword = "step36-test-role-pw";
        const sourceDbName = "snooker_club_pro_test_step36_role_source";
        const targetDbName = "snooker_club_pro_test_step36_role_target";
        const roleUrl = (dbName) => {
          const url = new URL(TEST_URL);
          url.username = roleName;
          url.password = rolePassword;
          url.pathname = `/${dbName}`;
          return url.toString();
        };

        const admin = new Pool({ connectionString: maintenanceUrl.toString() });
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${sourceDbName}`);
          await admin.query(`DROP DATABASE IF EXISTS ${targetDbName}`);
          await admin.query(`DROP ROLE IF EXISTS ${roleName}`);
          await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' CREATEDB`);
          await admin.query(`CREATE DATABASE ${sourceDbName} OWNER ${roleName}`);
          await admin.query(`CREATE DATABASE ${targetDbName} OWNER ${roleName}`);
        } finally {
          await admin.end();
        }

        t2.after(async () => {
          const cleanup = new Pool({ connectionString: maintenanceUrl.toString() });
          try {
            await cleanup.query(`DROP DATABASE IF EXISTS ${sourceDbName}`);
            await cleanup.query(`DROP DATABASE IF EXISTS ${targetDbName}`);
            await cleanup.query(`DROP ROLE IF EXISTS ${roleName}`);
          } finally {
            await cleanup.end();
          }
        });

        const sourcePool = new Pool({ connectionString: roleUrl(sourceDbName) });
        try {
          const isSuperuser = await sourcePool.query(`SELECT rolsuper FROM pg_roles WHERE rolname = '${roleName}'`);
          assert.equal(isSuperuser.rows[0].rolsuper, false, "this role must genuinely not be a superuser, or this test proves nothing");
        } finally {
          await sourcePool.end();
        }

        const roleEnv = { ...scriptEnv, DATABASE_URL: roleUrl(sourceDbName), BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "scp-pg-backup-role-test-")) };
        const migrateResult = await run(process.execPath, [path.join(__dirname, "..", "db", "migrate.js")], { env: roleEnv });
        assert.equal(migrateResult.code, 0, migrateResult.stdout + migrateResult.stderr);

        // Seed a genuinely circular pair at the DATA level: a session started from a booking,
        // then the booking updated to point back at that session - app.bookings.session_id and
        // app.sessions.booking_id each reference a row that, at insert time, does not exist yet
        // in the other table. This is real app behaviour (server/services/sessions.pg.service.js
        // / bookings.pg.service.js), not a contrived test fixture.
        const seedScript = `
          const tablesPg = require("${path.join(__dirname, "..", "services", "tables.pg.service").replace(/\\/g, "/")}");
          const customersPg = require("${path.join(__dirname, "..", "services", "customers.pg.service").replace(/\\/g, "/")}");
          const bookingsPg = require("${path.join(__dirname, "..", "services", "bookings.pg.service").replace(/\\/g, "/")}");
          const sessionsPg = require("${path.join(__dirname, "..", "services", "sessions.pg.service").replace(/\\/g, "/")}");
          const { query, closePool } = require("${path.join(__dirname, "..", "config", "db.pg").replace(/\\/g, "/")}");
          (async () => {
            const table = await tablesPg.createTable({ tableNumber: 1, hourlyRate: 500, status: "available" });
            const customer = await customersPg.createCustomer({ name: "Step 36 Circular Customer" });
            const booking = await bookingsPg.createBooking({
              customerId: customer.id, tableId: table.id, customerName: customer.name,
              tableNumber: table.tableNumber, startAt: new Date(Date.now() - 3600000), endAt: new Date(Date.now() + 3600000), status: "confirmed",
            });
            const session = await sessionsPg.startSession({ tableId: table.id });
            await query("UPDATE app.sessions SET booking_id = $1 WHERE id = $2", [booking.id, session.id]);
            await query("UPDATE app.bookings SET session_id = $1 WHERE id = $2", [session.id, booking.id]);
            console.log(JSON.stringify({ bookingId: booking.id, sessionId: session.id }));
            await closePool();
          })().catch((error) => { console.error(error); process.exitCode = 1; });
        `;
        const seedFile = path.join(roleEnv.BACKUP_DIR, "seed.js");
        fs.writeFileSync(seedFile, seedScript, "utf8");
        const seedResult = await run(process.execPath, [seedFile], { env: roleEnv });
        assert.equal(seedResult.code, 0, seedResult.stdout + seedResult.stderr);
        const { bookingId, sessionId } = JSON.parse(seedResult.stdout.trim().split("\n").pop());

        const backupResult = await run(process.execPath, [path.join(__dirname, "..", "scripts", "backupPostgres.js")], { env: roleEnv });
        assert.equal(backupResult.code, 0, backupResult.stdout + backupResult.stderr);
        const roleDumpFolder = path.join(roleEnv.BACKUP_DIR, "postgres");
        const roleDumpFile = path.join(roleDumpFolder, fs.readdirSync(roleDumpFolder).find((name) => name.endsWith(".dump")));

        const restoreResult = await run(
          process.execPath,
          [path.join(__dirname, "..", "scripts", "restorePostgresBackup.js"), `--file=${roleDumpFile}`, `--target=${roleUrl(targetDbName)}`],
          { env: roleEnv, input: "RESTORE\n" }
        );
        assert.equal(restoreResult.code, 0, restoreResult.stdout + restoreResult.stderr);
        assert.match(restoreResult.stdout, /Restore verified: every table's row count matches/);
        assert.doesNotMatch(restoreResult.stdout + restoreResult.stderr, /disable.trigger/i, "this restore never needed --disable-triggers");

        const targetPool = new Pool({ connectionString: roleUrl(targetDbName) });
        try {
          const booking = await targetPool.query("SELECT session_id FROM app.bookings WHERE id = $1", [bookingId]);
          const session = await targetPool.query("SELECT booking_id FROM app.sessions WHERE id = $1", [sessionId]);
          assert.equal(booking.rows[0].session_id, sessionId, "the circular link survived the restore, in both directions");
          assert.equal(session.rows[0].booking_id, bookingId, "the circular link survived the restore, in both directions");
        } finally {
          await targetPool.end();
        }

        fs.rmSync(roleEnv.BACKUP_DIR, { recursive: true, force: true });
      }
    );

    void manifestPath; // read above only to load `manifest`
  }
);
