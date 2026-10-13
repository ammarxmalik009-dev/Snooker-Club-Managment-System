// npm run backup:pg  ->  dumps the PostgreSQL database to a verifiable, timestamped archive.
//
// PostgreSQL-only: this never touches MongoDB. It exists so PostgreSQL data can be protected
// BEFORE any future Users/Auth cutover - the gap docs/USERS_AUTH_CUTOVER_RUNBOOK.md flags as
// still open until this script existed.
//
// Why pg_dump, not a hand-written serializer: server/services/backup.service.js writes its own
// XML format for MongoDB because MongoDB has no official single-database dump tool that fits
// this project's existing Mongoose/BSON model. PostgreSQL has its own, mature tool for exactly
// this - pg_dump/pg_restore - so this reuses them instead of inventing a second format.
//
// Verified choices (tested directly against the real local PostgreSQL 18.6, not assumed):
//   - The dump is NOT schema-scoped (`--schema=app`) even though all of this app's tables live in
//     the "app" schema - a schema-scoped dump was tried first and confirmed to DROP the
//     `btree_gist` extension (used by app.bookings's overlap-prevention constraint) from the
//     archive, which then silently fails to recreate that constraint on restore (pg_restore
//     continues past the error by default). A full-database dump includes the extension and
//     restores the constraint correctly - confirmed by re-testing.
//   - Session data (app.auth_sessions) and migration bookkeeping (app.schema_migrations) are
//     excluded from the data dumped (table STRUCTURE is still included) - sessions are nobody's
//     data, only who is logged in (the same policy backup.service.js already uses for MongoDB's
//     authsessions collection), and schema_migrations is recreated by the restore procedure's own
//     migration step, never by the dump.
//   - Format: pg_dump's own "custom" archive (-Fc) - its table of contents can be read back with
//     `pg_restore --list` WITHOUT connecting to any database - this script's own verification
//     step, run before the file is considered a real backup.
//
// The file is first written as "*.dump.tmp" and only renamed to "*.dump" once pg_dump exits
// successfully AND the verification step confirms the archive's contents - the same "never looks
// complete until it really is" rule server/services/backup.service.js already follows for
// MongoDB. A sibling "*.manifest.json" (per-table row counts, taken from the source right after
// the dump succeeds) is written alongside it - this is what a future restore compares against,
// so "the backup succeeded" means more than "pg_dump returned exit code 0".
//
// pg_dump/pg_restore are located via PG_DUMP_PATH/PG_RESTORE_PATH (explicit paths, if set) or the
// system PATH. Neither is assumed to be installed - if they aren't found, this reports that
// clearly instead of pretending a backup was made. Whether PostgreSQL client tools are available
// in this project's eventual Railway deployment is UNVERIFIED (no Railway project exists yet for
// this app - see docs/POSTGRES_MIGRATION.md) - this script is proven to work on a local
// PostgreSQL install only, documented as such, not claimed as production-ready.
//
// DATABASE_URL (and so any credentials in it) is passed to pg_dump as an argument, never printed.
// Anything this script DOES print is redacted with config/db.pg.js's own safePgTarget(), and
// pg_dump/pg_restore's own stderr is scanned for anything that looks like the connection string
// before being shown, as a second layer.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const env = require("../config/env");
const { query, closePool, safePgTarget } = require("../config/db.pg");

// server/db/migrations/0001_initial_schema.sql's own CREATE TABLE list (step 35's own audit of
// it). app.auth_sessions and app.schema_migrations are listed too (their STRUCTURE is always in
// the archive) but excluded from DATA_TABLES, whose row counts form the manifest.
const ALL_TABLES = [
  "app.users", "app.auth_sessions", "app.tables", "app.customers", "app.categories", "app.products",
  "app.players", "app.sessions", "app.bookings", "app.cafe_orders", "app.stock_movements",
  "app.matches", "app.match_players", "app.match_teams", "app.bills", "app.bill_line_items",
  "app.bill_players", "app.payments", "app.settings", "app.counters", "app.schema_migrations",
];
const EXCLUDED_DATA_TABLES = ["app.auth_sessions", "app.schema_migrations"];
const DATA_TABLES = ALL_TABLES.filter((table) => !EXCLUDED_DATA_TABLES.includes(table));
const MANIFEST_VERSION = 1;

function redact(text) {
  let result = String(text || "");
  if (env.databaseUrl) result = result.split(env.databaseUrl).join(safePgTarget(env.databaseUrl));
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

const pgDumpCommand = () => process.env.PG_DUMP_PATH || "pg_dump";
const pgRestoreCommand = () => process.env.PG_RESTORE_PATH || "pg_restore";

// "2026-10-10_21-00-05" in the club's time - the same file-naming convention backup.service.js
// already uses for the MongoDB backups.
function fileStamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.clubTimeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}_${value("hour")}-${value("minute")}-${value("second")}`;
}

async function tableRowCounts() {
  const counts = {};
  for (const table of DATA_TABLES) {
    const result = await query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

// pg_restore --list reads the archive's own table of contents WITHOUT connecting to any
// database - this is the verification a successful exit code alone does not provide. Confirms
// the archive contains the btree_gist extension and every table this script expects.
async function verifyArchive(filePath) {
  const result = await run(pgRestoreCommand(), ["--list", filePath]);
  if (result.code !== 0) {
    return { ok: false, reason: `pg_restore --list failed (exit ${result.code}): ${redact(result.stderr)}` };
  }
  const toc = result.stdout;
  if (!/EXTENSION\s+-\s+btree_gist/.test(toc)) {
    return { ok: false, reason: "the archive is missing the btree_gist extension - app.bookings's overlap-prevention constraint would not restore correctly" };
  }
  const missing = ALL_TABLES.filter((table) => {
    const [, name] = table.split(".");
    return !new RegExp(`TABLE\\s+app\\s+${name}\\s`).test(toc);
  });
  if (missing.length) {
    return { ok: false, reason: `the archive is missing expected tables: ${missing.join(", ")}` };
  }
  return { ok: true };
}

async function main() {
  console.log("\nSnooker Club Pro - PostgreSQL backup\n");
  if (!env.databaseUrl) {
    console.error("DATABASE_URL is not set. This is a PostgreSQL-only command - set DATABASE_URL in .env first (see .env.example).");
    return 1;
  }
  console.log(`Source database: ${safePgTarget(env.databaseUrl)}`);
  await query("SELECT 1"); // fail fast and clearly if PostgreSQL is unreachable, before anything else

  const folder = path.join(env.backupDir, "postgres");
  await fs.promises.mkdir(folder, { recursive: true });
  const now = new Date();
  const file = `snooker-postgres-backup-${fileStamp(now)}.dump`;
  const finalPath = path.join(folder, file);
  const tempPath = `${finalPath}.tmp`;

  const pgDump = pgDumpCommand();
  const dumpArgs = [
    "--format=custom", "--no-owner", "--no-privileges",
    "--exclude-table-data=app.auth_sessions", "--exclude-table-data=app.schema_migrations",
    `--file=${tempPath}`,
    env.databaseUrl,
  ];
  console.log("Running pg_dump...");
  const dumpResult = await run(pgDump, dumpArgs);
  if (dumpResult.code !== 0) {
    await fs.promises.unlink(tempPath).catch(() => {});
    if (dumpResult.code === -1) {
      console.error(`Could not run "${pgDump}" - install the PostgreSQL client tools (matching the server's major version, 18) or set PG_DUMP_PATH to its full path.`);
    } else {
      console.error(`pg_dump failed (exit ${dumpResult.code}): ${redact(dumpResult.stderr)}`);
    }
    return 1;
  }

  console.log("Verifying the archive (pg_restore --list - reads it without touching any database)...");
  const verification = await verifyArchive(tempPath);
  if (!verification.ok) {
    await fs.promises.unlink(tempPath).catch(() => {});
    console.error(`The backup file failed verification and was discarded: ${verification.reason}`);
    return 1;
  }

  const counts = await tableRowCounts();
  const manifest = {
    version: MANIFEST_VERSION,
    createdAt: now.toISOString(),
    source: safePgTarget(env.databaseUrl),
    excludedTables: EXCLUDED_DATA_TABLES,
    tables: counts,
  };
  await fs.promises.writeFile(`${finalPath}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.promises.rename(tempPath, finalPath);

  const { size } = await fs.promises.stat(finalPath);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(`\nBackup verified and saved: ${finalPath} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`${total} records across ${Object.keys(counts).length} tables (session data excluded, as documented above).`);
  console.log(`Manifest: ${finalPath}.manifest.json\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nCould not make the backup: ${redact(error.message)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
