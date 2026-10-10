// npm run create-admin  ->  creates the FIRST admin account (one-time setup).
//
// - Asks for name, username and password (the password is not shown while typing
//   and is never printed or logged).
// - Uses the same rules as the Users page (username format, strong password).
// - Refuses if an active admin already exists: after that, admins add users on the Users page.
// MongoDB must be running (npm run db).

const mongoose = require("mongoose");
const env = require("../config/env");
const { safeErrorMessage } = require("../config/db");
const { createFirstAdmin, countActiveAdmins } = require("../services/users.service");
const { passwordProblem } = require("../utils/password");
const { USERNAME_PATTERN } = require("../validators/auth.validators");
const { normalizeUsername } = require("../models/User");
const { createPrompt } = require("./prompt");

const { ask, askHidden, close: closePrompt } = createPrompt(); // shared with reset-admin-password (Phase 11.8)

async function main() {
  console.log("\nSnooker Club Pro - create the first admin account\n");
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.syncIndexes();

  if ((await countActiveAdmins()) > 0) {
    console.error("An active admin already exists. Log in as that admin and add users on the Users page.");
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
  console.log(`\nAdmin "${admin.username}" created. Start the app (npm run dev) and log in at http://localhost:${env.port}\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nCould not create the admin: ${safeErrorMessage(error)}`); // never includes the password (or the MONGODB_URI credentials)
    process.exitCode = 1;
  })
  .finally(async () => {
    closePrompt();
    await mongoose.disconnect();
  });
