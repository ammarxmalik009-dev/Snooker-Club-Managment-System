// Reads settings from the .env file (in the project root) and gives them clear names.
// Every other file imports settings from here instead of using process.env directly.

const path = require("node:path");
const net = require("node:net");
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

// Step 38: the same "fail loudly in production, warn in development" rule AUTH_SECRET already
// uses below, now also applied to the database address itself. Without this, a production
// deployment that forgot to set MONGODB_URI would silently fall back to
// "mongodb://127.0.0.1:27017/snooker_club_pro" - on a real host that address usually has nothing
// listening on it, so the app still refuses to start (connectToDatabase's own retry/exit-1 logic
// catches it), but the failure message then talks about "127.0.0.1:27017" as if that were a
// real, configured value, which is confusing, not a clear "you forgot to set MONGODB_URI".
// Development behaviour is UNCHANGED: the local default is still used, with no warning (every
// existing local/test workflow already relies on this).
function readMongoUri(value) {
  if (value && value.trim()) return value.trim();
  if (isProduction) {
    throw new Error("MONGODB_URI is not set. A production deployment must set it explicitly - there is no safe default to fall back to.");
  }
  return "mongodb://127.0.0.1:27017/snooker_club_pro";
}

// Step 38: PG_CUTOVER_ROUTES (server/config/cutover.js) names which route groups PostgreSQL
// should answer for; those adapters only work once DATABASE_URL is also set (server/config/
// db.pg.js's getPool() throws clearly, but only when something first queries it, not at
// start-up). Naming a route group without DATABASE_URL is always a misconfiguration - catching
// it here, at start-up, in every environment (not just production), is strictly earlier and
// clearer than waiting for the first request that needs it to fail.
function assertCutoverRoutesHaveDatabaseUrl(routesValue, databaseUrl) {
  const hasRoutes = String(routesValue || "").split(",").map((item) => item.trim()).filter(Boolean).length > 0;
  if (hasRoutes && !databaseUrl) {
    throw new Error("PG_CUTOVER_ROUTES names a route group, but DATABASE_URL is not set - PostgreSQL cutover needs both.");
  }
}

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

// Which proxies in front of the app may tell us the visitor's real IP (X-Forwarded-For).
// The IP is used by the login throttle, so trusting too much lets anyone fake their IP,
// and trusting too little makes every visitor look like the proxy (one lock for everybody).
//   empty / false / 0       no proxy: the club PC (default) - X-Forwarded-For is ignored
//   1 to 5                  the number of proxies in front of the app (hosting, e.g. Railway)
//   loopback, 10.0.0.0/8    a comma list of trusted proxy addresses (IP, IP/prefix or loopback/linklocal/uniquelocal)
// "true" (trust every proxy) is refused: then any visitor could send a fake X-Forwarded-For.
const PROXY_NAMES = ["loopback", "linklocal", "uniquelocal"];

function isProxyAddress(item) {
  if (PROXY_NAMES.includes(item)) return true;
  const [address, prefix, extra] = item.split("/");
  const version = net.isIP(address);
  if (!version || extra !== undefined) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

function readTrustProxy(value) {
  const text = (value || "").trim().toLowerCase();
  if (text === "" || text === "false" || text === "0") return false;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops >= 1 && hops <= 5) return hops;
  } else if (text !== "true") {
    const items = text.split(",").map((item) => item.trim());
    if (items.every(isProxyAddress)) return items;
  }
  throw new Error(`TRUST_PROXY must be empty, false, a number of proxies from 1 to 5, or a comma list of proxy addresses (got "${value}")`);
}

// Other websites (origins) whose pages may send changes (POST/PATCH/DELETE) to this API, on top of
// the app's own address. Needed when the pages are hosted elsewhere and reach the API through a
// rewrite (Vercel -> Railway): the browser's Origin is then the Vercel address, not this server's.
// Empty (default) = only the app's own address, as on the club PC. Each entry must be exactly
// http(s)://host[:port] - no wildcard, no path - so only the named sites are allowed.
function readAllowedOrigins(value) {
  const text = (value || "").trim();
  if (!text) return [];
  return text.split(",").map((item) => {
    const entry = item.trim();
    let url = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    const valid = url && !entry.includes("*")
      && (url.protocol === "https:" || url.protocol === "http:")
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      && /^https?:\/\/[^/?#]+\/?$/i.test(entry);
    if (!valid) {
      throw new Error(`ALLOWED_ORIGINS must be a comma list of addresses like https://club.example.com (no wildcard, no path) - "${entry}" is not valid`);
    }
    return url.origin; // lower case, default port removed: compared with the browser's Origin the same way
  });
}

const databaseUrl = process.env.DATABASE_URL || "";
assertCutoverRoutesHaveDatabaseUrl(process.env.PG_CUTOVER_ROUTES, databaseUrl);

const env = {
  nodeEnv,
  isProduction,
  port: readPort(process.env.PORT, 3000),
  mongoUri: readMongoUri(process.env.MONGODB_URI),
  clubTimeZone: readTimeZone(process.env.CLUB_TIMEZONE, "Asia/Karachi"),
  // Phase 2 (PostgreSQL foundation, optional): empty unless someone sets it. Nothing reads this at
  // start-up and no connection is made just because it's set - only server/config/db.pg.js, and only
  // when something actually calls it. The app's real database today is MongoDB (mongoUri above).
  databaseUrl,

  // ---- Login (Phase 8) ----
  authSecret: readAuthSecret(process.env.AUTH_SECRET),
  // How long a login lasts before the user must sign in again
  sessionTtlHours: readNumber(process.env.SESSION_TTL_HOURS, 12, 1, 24 * 30, "SESSION_TTL_HOURS"),
  // true = the login cookie is only sent over HTTPS. Turn on when the app is served with HTTPS.
  cookieSecure: (process.env.COOKIE_SECURE || (isProduction ? "true" : "false")).toLowerCase() === "true",
  // Proxies trusted for the visitor's IP (see readTrustProxy). Default false: the club PC has none.
  trustProxy: readTrustProxy(process.env.TRUST_PROXY),
  // Extra websites allowed to send changes (see readAllowedOrigins). Default []: only the app itself.
  allowedOrigins: readAllowedOrigins(process.env.ALLOWED_ORIGINS),

  // ---- Backups (XML) ----
  // Folder for the XML backups. Put it OUTSIDE the C: drive (D:, a USB drive or a OneDrive folder),
  // so the backups survive when Windows or the system drive breaks. Only set here, never from a web page.
  backupDir: readBackupDir(process.env.BACKUP_DIR),
  // Step 38: whether BACKUP_DIR was actually set, vs falling back to the auto-computed default
  // next to the app's own data. The default is a reasonable choice on the club PC (still warned
  // about via onSystemDrive, below) but is not a safe assumption anywhere else this app might
  // run (a container, a cloud host) - nothing here claims to know whether backupDir itself is a
  // durable location; this flag only reports whether BACKUP_DIR was explicitly configured at all.
  backupDirConfigured: Boolean(process.env.BACKUP_DIR && process.env.BACKUP_DIR.trim()),
};

// Empty = %LOCALAPPDATA%\SnookerClubPro\backups (next to the database, so on the system drive:
// the Settings page then warns that this does not protect against a broken PC)
function readBackupDir(value) {
  if (value && value.trim()) return path.resolve(value.trim());
  const appFolder = path.join(process.env.LOCALAPPDATA || require("node:os").homedir(), "SnookerClubPro");
  return path.join(appFolder, "backups");
}

module.exports = env;
