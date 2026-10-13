// npm run restore-backup:pg -- --file "<path to .dump>" --target "<postgres connection string>"
//   ->  puts data back from a PostgreSQL backup made by npm run backup:pg.
//
// PostgreSQL-only: never imports Mongoose, never touches MongoDB.
//
// SAFETY DESIGN (read before using this against anything that matters):
//   - There is NO default target. --target must be given explicitly every time - this never
//     reads DATABASE_URL as a fallback, so it can never silently land on whatever database the
//     app itself is currently configured to use.
//   - ALWAYS try this against an isolated recovery/test database first (a throwaway
//     --target, never the one you ultimately care about) and check the summary this script
//     prints before ever pointing it at anything real. This script cannot tell a "safe" target
//     from a "real" one by its name (a database named "test" is not proof of anything - this
//     project's own CLI-safety audit, Step 32, already rejected that idea for the admin
//     commands, for the same reason) - the only real safeguard is the confirmation prompts below,
//     and trying it somewhere disposable first.
//   - The archive is verified (pg_restore --list - no database touched) and its manifest
//     (<file>.manifest.json, written by backup:pg) is read, BEFORE asking for any confirmation.
//   - If the target already has PostgreSQL user accounts, this is almost certainly about to
//     overwrite real data: a SECOND, differently-worded confirmation ("OVERWRITE EXISTING DATA")
//     is required in addition to the normal "RESTORE" one. Typing anything else cancels; nothing
//     is changed until BOTH the required confirmations for that target are given.
//   - Restore procedure (verified directly against a real local PostgreSQL 18.6, not assumed):
//       1. Run the project's own migrations against the target (creates the schema/extension/
//          tables if they don't exist yet - idempotent, safe to run even if they already do).
//       2. If the target has existing data, every app table is TRUNCATEd first (never a partial
//          overwrite) - this is the one destructive step, and only runs after both required
//          confirmations.
//       3. `pg_restore --data-only --single-transaction` loads the backup's rows into the
//          now-correct, now-empty schema, all inside ONE transaction. This is the one safe way
//          found to avoid several real problems hit while designing this:
//            - a schema-scoped or --clean restore can drop the btree_gist extension's dependent
//              constraint (app.bookings's overlap rule) without restoring it;
//            - restoring directly over an already-populated database produces primary-key
//              conflicts;
//            - pg_restore's own TABLE DATA order is NOT dependency-aware by default (confirmed
//              directly against a real archive - it is close to alphabetical by table name), and
//              this schema has two foreign-key pairs that are genuinely circular at the data
//              level (app.bookings <-> app.sessions, app.bills <-> app.matches) - no row order
//              could satisfy either on its own. `pg_restore --disable-triggers` is the tool's own
//              answer to this, but it needs the restoring role to own the table (or be
//              superuser) - confirmed directly to work for a role that owns its own schema, but
//              NOT verified for whatever role a managed provider eventually grants. Step 36's own
//              audit fixed this at the SCHEMA level instead (migration 0002,
//              `server/db/migrations/0002_deferrable_foreign_keys.sql`): every foreign key in
//              schema "app" is DEFERRABLE INITIALLY DEFERRED, so `--single-transaction` alone is
//              enough - every row can load in any order, and every constraint is still checked
//              (at COMMIT, not weakened or skipped), with no elevated privilege needed beyond
//              ordinary table ownership, confirmed directly against a non-superuser role.
//       4. app.auth_sessions is always cleared after a restore (everyone logs in again) - the
//          same rule server/services/backup.service.js's own MongoDB restoreBackup() already
//          follows for MongoDB's authsessions collection.
//   - After restoring, every table's row count is compared against the manifest's own recorded
//     counts. A mismatch is reported as a FAILURE (non-zero exit), even though pg_restore itself
//     may have exited 0 - an exit code alone is not treated as proof the data is actually there.
//
// NOT YET VERIFIED, documented rather than assumed:
//   - This restore procedure (migration 0002 + `--single-transaction`, no `--disable-triggers`)
//     has been confirmed to work end to end against a real, non-superuser, schema-owning
//     PostgreSQL role locally - including both circular foreign-key pairs. Whatever role a real
//     managed provider eventually grants DATABASE_URL is still UNVERIFIED in that specific
//     environment (no Railway project exists yet) - this is a materially smaller gap than
//     needing superuser, but "smaller" is not "closed".
//   - Whether pg_dump/pg_restore are available wherever this script eventually runs in
//     production is equally unverified - see backupPostgres.js's own header for the same note.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createPrompt } = require("./prompt");

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(token);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const { file: fileArg, target: targetArg } = parseArgs(process.argv.slice(2));

async function listAvailableBackups() {
  // A minimal, read-only local require of just the env's own backupDir - safe before any
  // target is known, since this reads nothing from DATABASE_URL.
  const env = require("../config/env");
  const folder = path.join(env.backupDir, "postgres");
  let names = [];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    names = [];
  }
  console.log(`Backup folder: ${folder}`);
  const dumps = names.filter((name) => name.endsWith(".dump")).sort();
  if (!dumps.length) console.log("  (no PostgreSQL backups found)");
  for (const name of dumps) console.log(`  ${name}`);
  console.log('\nRun again with both: npm.cmd run restore-backup:pg -- --file="<full path>" --target="<postgres connection string>"\n');
}

async function main() {
  console.log("\nSnooker Club Pro - restore a PostgreSQL backup\n");

  if (!fileArg) {
    await listAvailableBackups();
    return 1;
  }
  if (!targetArg) {
    console.error('A --target is required - there is no default. Example:\n  npm.cmd run restore-backup:pg -- --file="<path>" --target="postgres://user@host:5433/dbname"');
    return 1;
  }

  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`Backup file not found: ${filePath}`);
    return 1;
  }
  const manifestPath = `${filePath}.manifest.json`;
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest found next to this backup (${manifestPath}). This script only restores backups made with npm run backup:pg, which always writes one.`);
    return 1;
  }
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));

  // Target is set BEFORE requiring anything that reads config/env - config/env.js reads
  // DATABASE_URL once, the first time it is required in this process, so this line must come
  // before any require of config/env, config/db.pg, db/migrate or any *.pg.service.js.
  process.env.DATABASE_URL = targetArg;

  const env = require("../config/env");
  const { query, closePool, safePgTarget } = require("../config/db.pg");
  const migrate = require("../db/migrate");

  function redact(text) {
    let result = String(text || "");
    result = result.split(targetArg).join(safePgTarget(targetArg));
    return result.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1***@");
  }

  function run(command, args) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + error.message }));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }
  const pgRestoreCommand = () => process.env.PG_RESTORE_PATH || "pg_restore";

  console.log(`Backup file: ${filePath}`);
  console.log(`Backup made: ${manifest.createdAt || "unknown"} from ${manifest.source || "an unknown source"}`);
  for (const [table, count] of Object.entries(manifest.tables || {})) console.log(`  ${table.padEnd(22)} ${count} records`);
  console.log(`Target database: ${safePgTarget(targetArg)}\n`);

  console.log("Verifying the archive (pg_restore --list - reads it without touching the target)...");
  const listResult = await run(pgRestoreCommand(), ["--list", filePath]);
  if (listResult.code !== 0) {
    if (listResult.code === -1) console.error(`Could not run "${pgRestoreCommand()}" - install the PostgreSQL client tools (matching version 18) or set PG_RESTORE_PATH to its full path.`);
    else console.error(`The backup file failed verification: ${redact(listResult.stderr)}`);
    return 1;
  }
  if (!/EXTENSION\s+-\s+btree_gist/.test(listResult.stdout)) {
    console.error("The backup file is missing the btree_gist extension entry - refusing to restore it (see backupPostgres.js's own header for why this matters).");
    return 1;
  }

  const { ask, close: closePrompt } = createPrompt();
  try {
    await query("SELECT 1"); // fail fast if the target is unreachable, before asking anything
    await migrate.runMigrations(); // creates schema/extension/tables if they don't exist yet - idempotent

    const existing = await query("SELECT count(*)::int AS n FROM app.users");
    const hasExistingData = existing.rows[0].n > 0;

    if (hasExistingData) {
      console.log(`\nThe target already has ${existing.rows[0].n} user(s) - this restore will REPLACE all data in it.`);
    } else {
      console.log("\nThe target has no existing users - this restore will populate it from the backup.");
    }
    console.log("Everyone currently logged in against the target will need to log in again.");

    const confirm1 = await ask("Type RESTORE to continue (anything else cancels): ");
    if (confirm1 !== "RESTORE") {
      console.log("Cancelled. Nothing was changed.\n");
      return 1;
    }
    if (hasExistingData) {
      const confirm2 = await ask('This target has existing data. Type exactly "OVERWRITE EXISTING DATA" to continue (anything else cancels): ');
      if (confirm2 !== "OVERWRITE EXISTING DATA") {
        console.log("Cancelled. Nothing was changed.\n");
        return 1;
      }
    }

    const DATA_TABLES = Object.keys(manifest.tables || {});
    // app.schema_migrations is deliberately NEVER truncated here - it is db/migrate.js's own
    // bookkeeping (which migration files have already run), not backup/restore data. Clearing it
    // would make the runMigrations() call above's own tracking wrong on a LATER restore attempt
    // against the same target: it would try to re-run "0001_initial_schema.sql" against tables
    // that already exist and fail with "relation ... already exists" - found and fixed while
    // testing this script against a target restored into twice in a row, not assumed safe.
    const allTablesForTruncate = [...DATA_TABLES, "app.auth_sessions"];
    if (hasExistingData) {
      await query(`TRUNCATE ${allTablesForTruncate.join(", ")} CASCADE`);
    } else {
      await query("TRUNCATE app.auth_sessions CASCADE"); // always: a restore never carries sessions over
    }

    console.log("\nRestoring data (pg_restore --data-only)...");
    const restoreResult = await run(pgRestoreCommand(), [
      "--data-only", "--single-transaction", "--no-owner", "--no-privileges",
      "-d", targetArg,
      filePath,
    ]);
    if (restoreResult.code !== 0) {
      console.error(`pg_restore reported a problem (exit ${restoreResult.code}): ${redact(restoreResult.stderr)}`);
      console.error("Because this runs as --single-transaction, nothing was committed - the target's data is unchanged (still whatever it was before this attempt, not a partial restore). Fix the problem (see the message above) and re-run.");
      return 1;
    }

    await query("TRUNCATE app.auth_sessions CASCADE"); // belt-and-braces: never carry sessions over, even if something above inserted any

    console.log("\nVerifying restored row counts against the backup's own manifest...");
    let mismatch = false;
    for (const table of DATA_TABLES) {
      const result = await query(`SELECT count(*)::int AS n FROM ${table}`);
      const expected = manifest.tables[table];
      const actual = result.rows[0].n;
      const ok = actual === expected;
      if (!ok) mismatch = true;
      console.log(`  ${table.padEnd(22)} expected ${expected}, restored ${actual}${ok ? "" : "  <-- MISMATCH"}`);
    }
    if (mismatch) {
      console.error("\nRow counts do not match the backup's manifest - do NOT treat this restore as successful. Investigate before relying on this target.");
      return 1;
    }

    console.log("\nRestore verified: every table's row count matches the backup's manifest.");
    console.log("All sessions were ended - everyone will need to log in again.\n");
    return 0;
  } finally {
    closePrompt();
    await closePool();
  }
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    let message = String(error.message || error);
    if (targetArg) message = message.split(targetArg).join("(the --target address)");
    message = message.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1***@");
    console.error(`\nCould not restore the backup: ${message}`);
    process.exitCode = 1;
  });
