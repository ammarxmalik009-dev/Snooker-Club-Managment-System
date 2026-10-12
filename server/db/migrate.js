// A small, dependency-free SQL migration runner for the optional PostgreSQL foundation
// (Phase 2, step 2.3 - see docs/POSTGRES_MIGRATION.md). No migration framework (node-pg-migrate,
// knex, umzug, ...) is used: the actual need is small - plain numbered .sql files, applied in
// order, tracked in one table - and the project's own MongoDB side has never used a migration
// framework either (its schemas grow by adding optional fields). Building this directly on top
// of server/config/db.pg.js keeps the dependency list exactly as it is after step 2.2.
//
// NEVER run automatically: nothing in server/server.js or server/app.js requires this file.
// It is only ever run deliberately, from the command line or a test:
//
//   node server/db/migrate.js            applies every pending migration, in filename order
//   node server/db/migrate.js status     lists applied and pending migrations - changes nothing
//
// Migration files live in server/db/migrations/*.sql, applied in plain lexicographic filename
// order (hence the "0001_", "0002_", ... prefix: it IS the order). Each file runs inside its own
// transaction (PostgreSQL supports transactional DDL, unlike most other databases) - if a file
// fails partway through, everything in it is rolled back and it is never recorded as applied, so
// re-running is always safe. All of this project's own tables live in the "app" schema (not the
// default "public" one), which this runner creates - a clean, disposable namespace: dropping it
// (`DROP SCHEMA app CASCADE`) removes only what this runner created.

const fs = require("node:fs");
const path = require("node:path");
const { getPool, withTransaction, closePool } = require("../config/db.pg");

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Every .sql file in the directory, sorted by filename - the order they are applied in.
function listMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
}

// Creates the "app" schema and the migration-history table if they don't exist yet. Safe to call
// every time (CREATE ... IF NOT EXISTS) - this is infrastructure, not itself a tracked migration
// (a migration can't record itself as applied in a table that doesn't exist yet).
async function ensureMigrationsTable() {
  await getPool().query("CREATE SCHEMA IF NOT EXISTS app");
  await getPool().query(
    "CREATE TABLE IF NOT EXISTS app.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  const result = await getPool().query("SELECT id FROM app.schema_migrations ORDER BY id");
  return result.rows.map((row) => row.id);
}

// { applied: [...], pending: [...] } - read-only, changes nothing.
async function status(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const all = listMigrationFiles(migrationsDir);
  const applied = await getAppliedMigrations();
  const appliedSet = new Set(applied);
  return { applied, pending: all.filter((file) => !appliedSet.has(file)) };
}

// Runs one migration file inside its own transaction, then records it as applied in the SAME
// transaction - so "ran the SQL" and "marked as applied" can never disagree with each other.
async function applyMigration(migrationsDir, file) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  await withTransaction(async (client) => {
    await client.query(sql);
    // Parameterized (never string-built from `file`), even though file names come from our own
    // directory listing, not user input - the same discipline as every other query in this project.
    await client.query("INSERT INTO app.schema_migrations (id) VALUES ($1)", [file]);
  });
}

// Applies every pending migration, in order, stopping at the first failure (later migrations
// are not attempted once an earlier one fails - deterministic, never partially out of order).
// Returns the list of files actually applied during this call.
async function runMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  await ensureMigrationsTable();
  const { pending } = await status(migrationsDir);
  const appliedNow = [];
  for (const file of pending) {
    await applyMigration(migrationsDir, file);
    appliedNow.push(file);
  }
  return appliedNow;
}

async function main() {
  const command = process.argv[2] || "up";
  try {
    if (command === "status") {
      const result = await status();
      console.log("Applied:", result.applied.length ? result.applied.join(", ") : "(none)");
      console.log("Pending:", result.pending.length ? result.pending.join(", ") : "(none)");
    } else if (command === "up") {
      const applied = await runMigrations();
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply - already up to date.");
    } else {
      console.error(`Unknown command "${command}". Use "up" (default) or "status".`);
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { listMigrationFiles, ensureMigrationsTable, getAppliedMigrations, status, applyMigration, runMigrations, DEFAULT_MIGRATIONS_DIR };
