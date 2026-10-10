// npm run restore-backup -- "D:\SnookerClubPro-Backups\snooker-backup-2026-10-10_21-00-05.xml"
//   ->  puts the club's data back from an XML backup.
//
// - Stop the app first (Ctrl+C in its terminal). Only the database must run (npm run db).
// - The file is checked completely first; a damaged or unfinished file changes nothing.
// - Before anything is replaced, the current data is saved as "snooker-before-restore-....xml"
//   in the backup folder, so a wrong restore can be undone.
// - Nothing changes until you type RESTORE. Everyone has to log in again afterwards.
// Without a file name it lists the backups in BACKUP_DIR.

const path = require("node:path");
const mongoose = require("mongoose");
const env = require("../config/env");
const { safeErrorMessage } = require("../config/db");
const backupService = require("../services/backup.service");
const { createPrompt } = require("./prompt");

const { ask, close: closePrompt } = createPrompt();

async function main() {
  console.log("\nSnooker Club Pro - restore the data from an XML backup\n");
  const fileArgument = process.argv[2];

  if (!fileArgument) {
    const files = await backupService.listBackups();
    console.log(`Backup folder: ${env.backupDir}`);
    if (!files.length) console.log("  (no backups found)");
    for (const backup of files) console.log(`  ${backup.file}   ${(backup.size / 1024).toFixed(0)} KB`);
    console.log('\nRun again with the file:  npm.cmd run restore-backup -- "<full path of the .xml file>"\n');
    return 1;
  }

  const filePath = path.resolve(fileArgument);
  console.log(`Reading ${filePath} ...`);
  const backup = await backupService.readBackupFile(filePath); // throws on a damaged or unfinished file
  console.log(`Backup made: ${backup.createdAt ? backup.createdAt.toISOString() : "unknown"}  (database "${backup.database}")\n`);
  for (const { name, documents } of backup.collections) console.log(`  ${name.padEnd(18)} ${documents.length} records`);

  // The models' indexes (unique bill numbers etc.) must exist, also in a brand-new, empty database
  require("../app").createApp();
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const target = mongoose.connection.name;

  console.log(`\nThis REPLACES the data of these collections in database "${target}" with the backup.`);
  console.log("Stop the app first (npm run dev / npm start). Everyone will have to log in again.");
  const answer = await ask('Type RESTORE to continue (anything else cancels): ');
  if (answer !== "RESTORE") {
    console.log("Cancelled. Nothing was changed.\n");
    return 1;
  }

  const safety = await backupService.writeBackupFile({ kind: "before-restore" });
  console.log(`\nCurrent data saved first: ${safety.path}`);

  const counts = await backupService.restoreBackup(backup);
  await mongoose.connection.syncIndexes();
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`Restored ${total} records in ${Object.keys(counts).length} collections.`);
  console.log(`Start the app (npm.cmd run dev) and log in at http://localhost:${env.port}\n`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(`\nCould not restore the backup: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    closePrompt();
    await mongoose.disconnect();
  });
