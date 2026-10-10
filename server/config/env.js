// Reads settings from the .env file (in the project root) and gives them clear names.
// Every other file imports settings from here instead of using process.env directly.

const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });

function readPort(value, fallback) {
  if (value === undefined || value === "") return fallback;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number between 1 and 65535 (got "${value}")`);
  }
  return port;
}

// The club's timezone decides what "today" or "2 October" means (e.g. for date filters).
// Times are always STORED in UTC; this is only used to interpret dates.
function readTimeZone(value, fallback) {
  const timeZone = value || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`CLUB_TIMEZONE "${timeZone}" is not a valid timezone (example: Asia/Karachi)`);
  }
  return timeZone;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

// Secret used to protect login sessions (it never leaves the server).
// Must be a long random value in .env. Without it, development uses a temporary
// random secret (everyone is logged out on restart); production refuses to start.
function readAuthSecret(value) {
  if (value && value.length >= 32 && !value.startsWith("change-me")) return value;
  if (isProduction) {
    throw new Error("AUTH_SECRET in .env must be a random value of at least 32 characters (see .env.example)");
  }
  console.warn("WARNING: AUTH_SECRET is missing or too short in .env - using a temporary secret (logins end when the server restarts).");
  return require("node:crypto").randomBytes(48).toString("hex");
}

function readNumber(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got "${value}")`);
  }
  return number;
}

const env = {
  nodeEnv,
  isProduction,
  port: readPort(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/snooker_club_pro",
  clubTimeZone: readTimeZone(process.env.CLUB_TIMEZONE, "Asia/Karachi"),

  // ---- Login (Phase 8) ----
  authSecret: readAuthSecret(process.env.AUTH_SECRET),
  // How long a login lasts before the user must sign in again
  sessionTtlHours: readNumber(process.env.SESSION_TTL_HOURS, 12, 1, 24 * 30, "SESSION_TTL_HOURS"),
  // true = the login cookie is only sent over HTTPS. Turn on when the app is served with HTTPS.
  cookieSecure: (process.env.COOKIE_SECURE || (isProduction ? "true" : "false")).toLowerCase() === "true",

  // ---- Backups (XML) ----
  // Folder for the XML backups. Put it OUTSIDE the C: drive (D:, a USB drive or a OneDrive folder),
  // so the backups survive when Windows or the system drive breaks. Only set here, never from a web page.
  backupDir: readBackupDir(process.env.BACKUP_DIR),
};

// Empty = %LOCALAPPDATA%\SnookerClubPro\backups (next to the database, so on the system drive:
// the Settings page then warns that this does not protect against a broken PC)
function readBackupDir(value) {
  if (value && value.trim()) return path.resolve(value.trim());
  const appFolder = path.join(process.env.LOCALAPPDATA || require("node:os").homedir(), "SnookerClubPro");
  return path.join(appFolder, "backups");
}

module.exports = env;
