// npm run reset-admin-password  ->  gives an existing ADMIN a new password (Phase 11.8).
//
// For the club owner who forgot the admin password: no other admin can reset it on the Users page.
// - Terminal only (run it on the club PC, with the database running: npm run db).
// - Only an existing, active admin can be reset. It never creates a user and never changes staff
//   or cashier accounts. If there is no active admin at all, use "npm run create-admin" instead.
// - The new password is typed twice, not shown, and checked with the same rules as everywhere else.
//   It is never printed or logged.
// - Every login of that admin ends (old cookies stop working); they log in again with the new password.

const mongoose = require("mongoose");
const env = require("../config/env");
const { safeErrorMessage } = require("../config/db");
const { listActiveAdmins, resetAdminPassword } = require("../services/users.service");
const { passwordProblem } = require("../utils/password");
const { normalizeUsername } = require("../models/User");
const { createPrompt } = require("./prompt");

const { ask, askHidden, close: closePrompt } = createPrompt();

async function main() {
  console.log("\nSnooker Club Pro - reset an admin's password\n");
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });

  const admins = await listActiveAdmins();
  if (admins.length === 0) {
    console.error("There is no active admin. Nothing was changed. Create the first admin with: npm.cmd run create-admin");
    return 1;
  }
  console.log(`Active admin${admins.length === 1 ? "" : "s"}: ${admins.map((a) => `${a.username} (${a.name})`).join(", ")}`);

  // One admin: Enter picks it. Several: type which one.
  const only = admins.length === 1 ? admins[0].username : null;
  let username = "";
  while (!admins.some((a) => a.username === username)) {
    const answer = normalizeUsername(await ask(only ? `Admin username [${only}]: ` : "Admin username: "));
    username = answer || only || "";
    if (!admins.some((a) => a.username === username)) console.log("  That is not an active admin. Type one of the usernames above.");
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
  console.log(`\nThe password of admin "${username}" was changed and all their logins were ended.`);
  console.log(`Log in with the new password at http://localhost:${env.port}\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nThe password was NOT changed: ${safeErrorMessage(error)}`); // never includes the password
    process.exitCode = 1;
  })
  .finally(async () => {
    closePrompt();
    await mongoose.disconnect();
  });
