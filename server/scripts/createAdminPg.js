// npm run create-admin:pg  ->  creates the FIRST PostgreSQL administrator (Phase 3 Group 2 prep).
//
// PostgreSQL-only: this command never imports Mongoose and never touches MongoDB. It exists so a
// PostgreSQL admin account can be created and its login verified BEFORE the Users/Auth cutover is
// ever activated (server/config/cutover.js's KNOWN_ROUTE_GROUPS still does not include "users" -
// this script does not change that, and running it has no effect on which backend any HTTP
// request uses).
//
// - Asks for name, username and password (the password is not shown while typing and is never
//   printed or logged).
// - Uses the exact same business rules as the real app would once cutover is on: username format
//   and password strength (server/utils/password.js), and createFirstAdmin's own duplicate-admin
//   refusal (server/services/users.pg.service.js) - nothing here re-implements or loosens those.
// - DATABASE_URL must point at PostgreSQL (see .env.example). If it is missing or unreachable,
//   this fails clearly and does not fall back to MongoDB or any other database.

const env = require("../config/env");
const { closePool, safePgTarget, query } = require("../config/db.pg");
const { createFirstAdmin, countActiveAdmins, normalizeUsername } = require("../services/users.pg.service");
const { passwordProblem } = require("../utils/password");
const { USERNAME_PATTERN } = require("../validators/auth.validators");
const { createPrompt } = require("./prompt");

const { ask, askHidden, close: closePrompt } = createPrompt(); // shared with resetAdminPasswordPg

// An error message with the connection string (or any "user:password@" part of it) taken out -
// the same idea as config/db.js's own safeErrorMessage, kept as a small local copy here because
// db.pg.js does not export one (only safePgTarget, for displaying the target, not for redacting
// an arbitrary error's text).
function safePgErrorMessage(error) {
  let message = String((error && error.message) || error || "Unknown error");
  if (env.databaseUrl) message = message.split(env.databaseUrl).join(safePgTarget(env.databaseUrl));
  return message.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1***@");
}

async function main() {
  console.log("\nSnooker Club Pro - create the first PostgreSQL admin account\n");
  if (!env.databaseUrl) {
    console.error("DATABASE_URL is not set. This is a PostgreSQL-only command - set DATABASE_URL in .env first (see .env.example).");
    return 1;
  }
  console.log(`Target database: ${safePgTarget(env.databaseUrl)}\n`);
  await query("SELECT 1"); // fail fast and clearly if PostgreSQL is unreachable, before asking anything

  if ((await countActiveAdmins()) > 0) {
    console.error("An active PostgreSQL admin already exists. Log in as that admin and add users on the Users page (once Users/Auth cutover is active).");
    return 1;
  }

  let name = "";
  while (name.length < 2 || name.length > 60) {
    name = await ask("Full name: ");
    if (name.length < 2 || name.length > 60) console.log("  Name must be 2 to 60 characters.");
  }

  let username = "";
  while (!USERNAME_PATTERN.test(username)) {
    username = normalizeUsername(await ask("Username: "));
    if (!USERNAME_PATTERN.test(username)) console.log("  Username must be 3-30 letters, numbers, dots, dashes or underscores.");
  }

  let password = "";
  for (;;) {
    password = await askHidden("Password (at least 10 characters, letters and numbers): ");
    const problem = passwordProblem(password, username);
    if (problem) {
      console.log(`  ${problem}.`);
      continue;
    }
    const again = await askHidden("Repeat the password: ");
    if (again !== password) {
      console.log("  The passwords don't match. Try again.");
      continue;
    }
    break;
  }

  const admin = await createFirstAdmin({ name, username, password });
  console.log(`\nPostgreSQL admin "${admin.username}" created. This does NOT activate the Users/Auth cutover - that remains a separate, explicit step.\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nCould not create the admin: ${safePgErrorMessage(error)}`); // never the password, never database credentials
    process.exitCode = 1;
  })
  .finally(async () => {
    closePrompt();
    await closePool();
  });
