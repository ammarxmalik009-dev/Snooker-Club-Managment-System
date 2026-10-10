// npm run db  ->  starts the local (portable) MongoDB server.
// Keep this terminal open while you use the app. Press Ctrl+C to stop MongoDB.
//
// Where things are (can be changed in .env):
//   MONGOD_PATH     the mongod.exe program
//   MONGO_DATA_DIR  the folder where MongoDB stores the club's data

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });

const appFolder = path.join(process.env.LOCALAPPDATA || require("node:os").homedir(), "SnookerClubPro");
const mongodPath = process.env.MONGOD_PATH || path.join(appFolder, "mongodb", "bin", "mongod.exe");
const dataDir = process.env.MONGO_DATA_DIR || path.join(appFolder, "mongo-data");

if (!fs.existsSync(mongodPath)) {
  console.error(`\nmongod was not found at:\n  ${mongodPath}`);
  console.error("Install MongoDB or set MONGOD_PATH in .env to the full path of mongod.exe.\n");
  process.exit(1);
}

const logFile = path.join(path.dirname(dataDir), "mongo-logs", "mongod.log");

// MongoDB needs these folders to exist
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });

console.log(`Starting MongoDB...\n  program: ${mongodPath}\n  data:    ${dataDir}\n  log:     ${logFile}\n`);

const mongod = spawn(
  mongodPath,
  [
    "--dbpath", dataDir,
    "--bind_ip", "127.0.0.1", // only this computer can connect
    "--port", "27017",
    "--logpath", logFile,     // MongoDB's own (very detailed) log goes to a file
    "--logappend",
  ],
  { stdio: "inherit" }
);

mongod.on("spawn", () => {
  console.log("MongoDB is running on 127.0.0.1:27017");
  console.log("Leave this window open. Start the app in another terminal: npm run dev");
  console.log("Press Ctrl+C here to stop MongoDB.\n");
});

mongod.on("error", (error) => {
  console.error("Could not start MongoDB:", error.message);
  process.exit(1);
});

mongod.on("exit", (code) => {
  if (code === 0 || code === null) {
    console.log("MongoDB stopped.");
  } else if (code === 48) {
    console.error("\nMongoDB could not start: port 27017 is already in use (MongoDB is probably already running).\n");
  } else {
    console.error(`\nMongoDB stopped with exit code ${code}. Details are in the log file:\n  ${logFile}\n`);
  }
  process.exit(code || 0);
});

// Ctrl+C reaches MongoDB too, and MongoDB then shuts down cleanly by itself.
// We just wait for it. Only if it hangs for 15 seconds do we force it to stop.
process.on("SIGINT", () => {
  console.log("\nStopping MongoDB (saving data)...");
  setTimeout(() => mongod.kill(), 15000).unref();
});
