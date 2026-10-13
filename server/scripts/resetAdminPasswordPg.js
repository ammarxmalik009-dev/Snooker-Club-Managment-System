// npm run reset-admin-password:pg  ->  gives an existing ACTIVE PostgreSQL admin a new password.
//
// PostgreSQL-only: this command never imports Mongoose and never touches MongoDB. For the same
// recovery situation as npm run reset-admin-password, but on the PostgreSQL side - useful for
// testing PostgreSQL admin recovery before the Users/Auth cutover is ever activated
// (server/config/cutover.js's KNOWN_ROUTE_GROUPS still does not include "users"; running this
// script has no effect on which backend any HTTP request uses).
//
// - Terminal only. PostgreSQL must be reachable via DATABASE_URL (see .env.example).
// - Only an existing, active PostgreSQL admin can be reset - chosen from the list this script
//   itself prints (server/services/users.pg.service.js's own listActiveAdmins). An arbitrary
//   typed username that isn't in that list is never accepted, the same safe-selection rule
//   npm run reset-admin-password already uses.
// - The new password is typed twice, not shown, and checked with the same rules as everywhere
//   else (server/utils/password.js). It is never printed or logged.
// - resetAdminPassword (server/services/users.pg.service.js) ends every one of that admin's
//   PostgreSQL sessions - the same "all logins end" guarantee as the MongoDB version.
// - This never updates a password hash with raw SQL - only the already-tested service function.

const env = require("../config/env");
const { closePool, safePgTarget, query } = require("../config/db.pg");
const { listActiveAdmins, resetAdminPassword, normalizeUsername } = require("../services/users.pg.service");
const { passwordProblem } = require("../utils/password");
const { createPrompt } = require("./prompt");

const { ask, askHidden, close: closePrompt } = createPrompt();

// Small local copy of config/db.js's safeErrorMessage idea - see createAdminPg.js's own copy for
// why this isn't imported from db.pg.js (it doesn't export one).
function safePgErrorMessage(error) {
  let message = String((error && error.message) || error || "Unknown error");
  if (env.databaseUrl) message = message.split(env.databaseUrl).join(safePgTarget(env.databaseUrl));
  return message.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1***@");
}

async function main() {
  console.log("\nSnooker Club Pro - reset a PostgreSQL admin's password\n");
  if (!env.databaseUrl) {
    console.error("DATABASE_URL is not set. This is a PostgreSQL-only command - set DATABASE_URL in .env first (see .env.example).");
    return 1;
  }
  console.log(`Target database: ${safePgTarget(env.databaseUrl)}\n`);
  await query("SELECT 1"); // fail fast and clearly if PostgreSQL is unreachable, before asking anything

  const admins = await listActiveAdmins();
  if (admins.length === 0) {
    console.error("There is no active PostgreSQL admin. Nothing was changed. Create the first admin with: npm.cmd run create-admin:pg");
    return 1;
  }
  console.log(`Active PostgreSQL admin${admins.length === 1 ? "" : "s"}: ${admins.map((a) => `${a.username} (${a.name})`).join(", ")}`);

  // One admin: Enter picks it. Several: type which one. Same safe-selection rule as
  // reset-admin-password - only a username from the list above is ever accepted.
  const only = admins.length === 1 ? admins[0].username : null;
  let username = "";
  while (!admins.some((a) => a.username === username)) {
    const answer = normalizeUsername(await ask(only ? `Admin username [${only}]: ` : "Admin username: "));
    username = answer || only || "";
    if (!admins.some((a) => a.username === username)) console.log("  That is not an active PostgreSQL admin. Type one of the usernames above.");
  }

  let password = "";
  for (;;) {
    password = await askHidden("New password (at least 10 characters, letters and numbers): ");
    const problem = passwordProblem(password, username);
    if (problem) {
      console.log(`  ${problem}.`);
      continue;
    }
    const again = await askHidden("Repeat the new password: ");
    if (again !== password) {
      console.log("  The passwords don't match. Try again.");
      continue;
    }
    break;
  }

  await resetAdminPassword(username, password);
  console.log(`\nThe password of PostgreSQL admin "${username}" was changed and all their PostgreSQL logins were ended.\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nThe password was NOT changed: ${safePgErrorMessage(error)}`); // never the password, never database credentials
    process.exitCode = 1;
  })
  .finally(async () => {
    closePrompt();
    await closePool();
  });
