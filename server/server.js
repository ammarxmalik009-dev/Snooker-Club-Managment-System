// Starting point: npm run dev  (or: npm start)
// 1. connect to MongoDB  2. start the web server  3. shut down cleanly on Ctrl+C

const env = require("./config/env");
const { connectToDatabase, disconnectFromDatabase, databaseStartupMessage } = require("./config/db");
const { createApp } = require("./app");

async function start() {
  try {
    await connectToDatabase();
  } catch (error) {
    // Phase 11.8: "can't connect" and "connected, but the index update failed" are told apart,
    // the hint is the project's own database (npm run db), and the MONGODB_URI is never printed whole
    console.error(`\n${databaseStartupMessage(error).join("\n")}\n`);
    await disconnectFromDatabase().catch(() => {});
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`Server running at http://localhost:${env.port}  (${env.nodeEnv})`);
  });

  // Every minute: bookings nobody checked in for become "no-show" (Phase 7).
  // (Bookings are also checked whenever they are read, so this is a safety net.)
  const { markNoShows } = require("./services/bookings.service");
  const noShowTimer = setInterval(() => {
    markNoShows().catch((error) => console.error("No-show check failed:", error.message));
  }, 60 * 1000);
  noShowTimer.unref(); // don't keep the process alive just for this timer

  // Every minute: is an XML backup due? (every N hours, set on the Settings page; default 12).
  // After a start, an overdue backup (the app was off) is made at the first check.
  const { runScheduledBackupIfDue } = require("./services/backup.service");
  const backupTimer = setInterval(() => {
    runScheduledBackupIfDue().catch((error) => console.error("Backup failed:", error.message));
  }, 60 * 1000);
  backupTimer.unref();

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\nPort ${env.port} is already in use. Stop the other program or change PORT in .env\n`);
    } else {
      console.error("Server error:", error);
    }
    process.exit(1);
  });

  // Ctrl+C (SIGINT) or a stop signal: finish open requests, close the database, exit
  async function shutDown(signal) {
    console.log(`\n${signal} received - shutting down...`);
    server.close(async () => {
      await disconnectFromDatabase();
      console.log("Stopped cleanly.");
      process.exit(0);
    });
  }
  process.on("SIGINT", () => shutDown("SIGINT"));
  process.on("SIGTERM", () => shutDown("SIGTERM"));
}

start();
