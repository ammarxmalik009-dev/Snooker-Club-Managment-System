// Connects Mongoose (our MongoDB library) to the database.

const mongoose = require("mongoose");
const env = require("./env");

// Fail fast: if the database is down, queries throw an error straight away
// instead of silently waiting (buffering) in memory.
mongoose.set("bufferCommands", false);

// Only allow fields that are defined in a schema when filtering
mongoose.set("strictQuery", true);

// Readable names for mongoose.connection.readyState (0-3)
const CONNECTION_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

// Phase 11.8: where the database is, WITHOUT a user name, password or options - safe to print.
// "mongodb://admin:secret@db.local:27017/club?authSource=admin" -> "db.local:27017/club"
function safeMongoTarget(uri) {
  try {
    const url = new URL(uri);
    if (!/^mongodb(\+srv)?:$/.test(url.protocol)) return "(the address in MONGODB_URI)";
    const database = url.pathname.replace(/^\//, "");
    return `${url.host}${database ? `/${database}` : ""}`;
  } catch {
    return "(the address in MONGODB_URI)";
  }
}

// An error message with any "user:password@" part (or the whole connection string) taken out
function safeErrorMessage(error, uri = env.mongoUri) {
  let message = String((error && error.message) || error || "Unknown error");
  if (uri) message = message.split(uri).join(safeMongoTarget(uri));
  return message.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, "$1***@");
}

// Two steps, reported separately (Phase 11.8): a failed index update is NOT "can't connect".
//   error.stage = "connect" -> MongoDB can't be reached
//   error.stage = "indexes" -> connected, but updating the indexes failed (e.g. existing duplicates)
async function connectToDatabase({ uri = env.mongoUri, timeoutMS = 5000 } = {}) {
  try {
    // Stop trying after 5 seconds, so a missing MongoDB gives a quick, clear error
    await mongoose.connect(uri, { serverSelectionTimeoutMS: timeoutMS });
  } catch (error) {
    error.stage = "connect";
    throw error;
  }

  try {
    // Make sure every index defined in the models (e.g. "table numbers are unique")
    // exists in the database before the first request arrives
    await mongoose.connection.syncIndexes();
  } catch (error) {
    error.stage = "indexes";
    throw error;
  }

  const { host, port, name } = mongoose.connection;
  console.log(`MongoDB connected: ${host}:${port}/${name}`);

  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));
}

// What server.js prints when the database step of the start fails (never the full MONGODB_URI)
function databaseStartupMessage(error, uri = env.mongoUri) {
  const target = safeMongoTarget(uri);
  const reason = safeErrorMessage(error, uri);
  if (error && error.stage === "indexes") {
    return [
      `MongoDB connected (${target}), but updating the database indexes failed: ${reason}`,
      "  - No data was changed. A unique index can't be built while existing records break its rule (for example two records with the same value).",
      "  - Note the message above and ask the developer. Don't edit the database by hand.",
    ];
  }
  return [
    `Could not connect to MongoDB (${target}): ${reason}`,
    "  - Start the club's database in another terminal and leave it open:  npm.cmd run db",
    "  - Then start the app again (npm.cmd run dev). If MONGODB_URI in .env was changed, check it.",
  ];
}

function getDatabaseStatus() {
  return CONNECTION_STATES[mongoose.connection.readyState] || "unknown";
}

async function disconnectFromDatabase() {
  await mongoose.disconnect();
}

module.exports = { connectToDatabase, getDatabaseStatus, disconnectFromDatabase, safeMongoTarget, safeErrorMessage, databaseStartupMessage };
