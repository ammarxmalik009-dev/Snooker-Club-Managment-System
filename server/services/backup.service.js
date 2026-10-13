// Backups: the WHOLE database saved as one XML file, and read back by the restore script.
//
// - A backup is made every N hours (Settings page: on/off, hours, how many files to keep) and with
//   the "Backup Now" button. The folder is BACKUP_DIR in .env (outside the C: drive, so the backups
//   survive a broken PC).
// - Every collection is saved except login sessions (authsessions: nobody's data, only who is logged in).
// - Every value keeps its type (t="objectId", "date", "number" ...), so a restore gives back exactly
//   the same records: same ids, bill numbers, dates and links between records.
// - The file is first written as "*.xml.tmp" and only renamed to "*.xml" when it is complete,
//   so a half-written backup never looks like a good one.
//
// File layout:
//   <snookerBackup version="1" createdAt="2026-10-10T16:00:00.000Z" database="snooker_club_pro">
//     <collection name="bills" count="1">
//       <doc>
//         <f n="_id" t="objectId">66f1...</f>
//         <f n="total" t="number">50000</f>
//         <f n="lines" t="array"><f t="object">...</f></f>
//       </doc>
//     </collection>
//   </snookerBackup>

const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const env = require("../config/env");
const { Setting } = require("../models/Setting");
const { getSettings } = require("./settings.service");
const AppError = require("../utils/AppError");

const { ObjectId, Decimal128, Long, Binary } = mongoose.mongo;

const FORMAT_VERSION = 1;
const SKIPPED_COLLECTIONS = new Set(["authsessions"]);
// "backup" = made by the timer or the Backup Now button (old ones are deleted after N files);
// "before-restore" = made by the restore script just before it replaces the data (never deleted automatically)
const FILE_PATTERN = /^snooker-(backup|before-restore)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.xml$/;
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000; // a failed timed backup is tried again after 15 minutes

// ---------- Writing XML ----------

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Text XML can't hold safely (control characters, "\r", broken surrogates) is saved as base64 instead
function needsBase64(text) {
  return /[^\t\n -퟿-�\u{10000}-\u{10FFFF}]|\r/u.test(text);
}

function nameAttribute(name) {
  if (name === null) return ""; // array items have no name
  if (needsBase64(name) || /[\t\n]/.test(name)) return ` n="${Buffer.from(name, "utf8").toString("base64")}" ne="base64"`;
  return ` n="${escapeXml(name)}"`;
}

function textElement(name, type, text, extra = "") {
  return `<f${nameAttribute(name)} t="${type}"${extra}>${text}</f>`;
}

// One value (and everything inside it) as XML
function valueToXml(name, value) {
  if (value === null || value === undefined) return `<f${nameAttribute(name)} t="null"/>`;
  if (typeof value === "string") {
    return needsBase64(value)
      ? textElement(name, "string", Buffer.from(value, "utf8").toString("base64"), ' e="base64"')
      : textElement(name, "string", escapeXml(value));
  }
  if (typeof value === "number") return textElement(name, "number", String(value));
  if (typeof value === "boolean") return textElement(name, "bool", String(value));
  if (typeof value === "bigint") return textElement(name, "long", value.toString());
  if (value instanceof Date) return textElement(name, "date", Number.isNaN(value.getTime()) ? "invalid" : value.toISOString());
  if (Array.isArray(value)) return `<f${nameAttribute(name)} t="array">${value.map((item) => valueToXml(null, item)).join("")}</f>`;

  switch (value._bsontype) {
    case "ObjectId": return textElement(name, "objectId", value.toHexString());
    case "Decimal128": return textElement(name, "decimal", value.toString());
    case "Long": return textElement(name, "long", value.toString());
    case "Int32":
    case "Double": return textElement(name, "number", String(value.valueOf()));
    case "Binary": return textElement(name, "binary", Buffer.from(value.buffer).toString("base64"), ` sub="${value.sub_type}"`);
    case undefined: break;
    default: throw new Error(`Field "${name}" has a value type the backup can't save (${value._bsontype})`);
  }
  if (Buffer.isBuffer(value)) return textElement(name, "binary", value.toString("base64"), ' sub="0"');

  const fields = Object.entries(value).map(([key, item]) => valueToXml(key, item)).join("");
  return `<f${nameAttribute(name)} t="object">${fields}</f>`;
}

function documentToXml(document) {
  return `<doc>${Object.entries(document).map(([key, value]) => valueToXml(key, value)).join("")}</doc>`;
}

// ---------- Reading XML ----------

const parser = new XMLParser({
  preserveOrder: true,       // keeps the field order of every record
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,      // values stay text; the t="..." attribute decides the type
  parseAttributeValue: false,
  trimValues: false,         // "  Ali " stays "  Ali "
});

function elementName(node) {
  return Object.keys(node).find((key) => key !== ":@");
}

function elementText(children) {
  return children.filter((child) => "#text" in child).map((child) => String(child["#text"])).join("");
}

function childElements(children, tag) {
  return children.filter((child) => elementName(child) === tag);
}

function fieldName(attributes) {
  return attributes.ne === "base64" ? Buffer.from(attributes.n, "base64").toString("utf8") : attributes.n;
}

function xmlToValue(node) {
  const attributes = node[":@"] || {};
  const children = node.f || [];
  const text = elementText(children);
  switch (attributes.t) {
    case "null": return null;
    case "string": return attributes.e === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
    case "number": return Number(text);
    case "bool": return text === "true";
    case "date": return new Date(text === "invalid" ? NaN : text);
    case "objectId": return new ObjectId(text);
    case "decimal": return Decimal128.fromString(text);
    case "long": return Long.fromString(text);
    case "binary": return new Binary(Buffer.from(text, "base64"), Number(attributes.sub) || 0);
    case "array": return childElements(children, "f").map(xmlToValue);
    case "object": return fieldsToObject(childElements(children, "f"));
    default: throw new Error(`Unknown value type "${attributes.t}" in the backup file`);
  }
}

function fieldsToObject(fieldNodes) {
  const result = {};
  for (const node of fieldNodes) result[fieldName(node[":@"] || {})] = xmlToValue(node);
  return result;
}

// Reads a backup file's text -> { createdAt, database, collections: [{ name, documents }] }.
// Refuses a damaged or unfinished file (bad XML, wrong record count) instead of restoring half of it.
function parseBackupXml(xmlText) {
  const check = XMLValidator.validate(xmlText);
  if (check !== true) {
    throw new Error(`The backup file is damaged or incomplete (line ${check.err.line}: ${check.err.msg})`);
  }
  const top = parser.parse(xmlText).find((node) => elementName(node) === "snookerBackup");
  if (!top) throw new Error("This is not a Snooker Club Pro backup file");
  const meta = top[":@"] || {};
  if (Number(meta.version) !== FORMAT_VERSION) throw new Error(`Unknown backup format version "${meta.version}"`);

  const collections = childElements(top.snookerBackup, "collection").map((node) => {
    const attributes = node[":@"] || {};
    const documents = childElements(node.collection, "doc").map((doc) => fieldsToObject(childElements(doc.doc, "f")));
    if (documents.length !== Number(attributes.count)) {
      throw new Error(`The backup file is incomplete: "${attributes.name}" should have ${attributes.count} records but has ${documents.length}`);
    }
    return { name: attributes.name, documents };
  });
  return { createdAt: meta.createdAt ? new Date(meta.createdAt) : null, database: meta.database || "", collections };
}

async function readBackupFile(filePath) {
  return parseBackupXml(await fs.promises.readFile(filePath, "utf8"));
}

// ---------- Files and folder ----------

// "2026-10-10_21-00-05" in the club's time, for the file name
function fileStamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.clubTimeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}_${value("hour")}-${value("minute")}-${value("second")}`;
}

// Is the backup folder on the same drive as Windows? Then a broken PC can take the backups with it.
// `configured` (Step 38) is a separate, platform-agnostic signal: whether BACKUP_DIR was actually
// set, rather than falling back to the auto-computed default. onSystemDrive only ever means
// anything on the club PC (it is always false on Linux/Railway, by construction - there is no
// "system drive" there); a deployment with BACKUP_DIR unset gets NO onSystemDrive warning on a
// host where that check cannot apply at all, so `configured` exists to still say "this folder's
// durability has not been confirmed" instead of silently implying everything is fine.
function describeBackupFolder(folder = env.backupDir) {
  const systemDrive = (process.env.SystemDrive || "C:").toUpperCase();
  const onSystemDrive = process.platform === "win32" && path.parse(path.resolve(folder)).root.toUpperCase().startsWith(systemDrive);
  return { folder, onSystemDrive, configured: env.backupDirConfigured };
}

async function listBackups(folder = env.backupDir) {
  let names;
  try {
    names = await fs.promises.readdir(folder);
  } catch (error) {
    if (error.code === "ENOENT") return []; // no backup made yet
    throw error;
  }
  const files = [];
  for (const file of names.filter((name) => FILE_PATTERN.test(name))) {
    const stats = await fs.promises.stat(path.join(folder, file));
    files.push({ file, size: stats.size, modifiedAt: stats.mtime });
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// Full path of one backup file, only for real backup file names (never "..\..\something")
function backupFilePath(file, folder = env.backupDir) {
  if (typeof file !== "string" || !FILE_PATTERN.test(file)) throw new AppError("Backup file not found", 404);
  const fullPath = path.join(folder, file);
  if (!fs.existsSync(fullPath)) throw new AppError("Backup file not found", 404);
  return fullPath;
}

// Keeps the newest `keepCount` timed/manual backups; "before-restore" files are never deleted here
async function deleteOldBackups(keepCount, folder = env.backupDir) {
  const backups = (await listBackups(folder)).filter((backup) => backup.file.startsWith("snooker-backup-"));
  for (const old of backups.slice(keepCount)) {
    await fs.promises.unlink(path.join(folder, old.file)).catch(() => {});
  }
}

// ---------- Making a backup ----------

// Writes the whole database to a new XML file. Returns { file, path, size, createdAt, counts }.
async function writeBackupFile({ kind = "backup", folder = env.backupDir, db = mongoose.connection.db, now = new Date() } = {}) {
  if (!db || mongoose.connection.readyState !== 1) throw new AppError("The database is not connected, so no backup can be made", 503);

  await fs.promises.mkdir(folder, { recursive: true });
  const file = `snooker-${kind}-${fileStamp(now)}.xml`;
  const finalPath = path.join(folder, file);
  const tempPath = `${finalPath}.tmp`;

  const collectionNames = (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .filter((name) => !name.startsWith("system.") && !SKIPPED_COLLECTIONS.has(name))
    .sort();

  const counts = {};
  const handle = await fs.promises.open(tempPath, "w");
  try {
    await handle.write(`<?xml version="1.0" encoding="UTF-8"?>\n<snookerBackup version="${FORMAT_VERSION}" app="Snooker Club Pro" ` +
      `createdAt="${now.toISOString()}" database="${escapeXml(db.databaseName)}">\n`);
    for (const name of collectionNames) {
      const documents = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
      counts[name] = documents.length;
      await handle.write(`  <collection name="${escapeXml(name)}" count="${documents.length}">\n`);
      for (const document of documents) await handle.write(`    ${documentToXml(document)}\n`);
      await handle.write("  </collection>\n");
    }
    await handle.write("</snookerBackup>\n");
    await handle.sync(); // really on the disk before it gets its final name
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
  await handle.close();
  await fs.promises.rename(tempPath, finalPath);

  const { size } = await fs.promises.stat(finalPath);
  return { file, path: finalPath, size, createdAt: now, counts };
}

let running = null; // one backup at a time (the timer and the button never write at once)

// A timed or Backup Now backup: writes the file, deletes the oldest ones, saves the status in Settings
async function runBackup() {
  if (running) throw new AppError("A backup is already being made. Try again in a moment.", 409);
  running = (async () => {
    const settings = await getSettings();
    const attemptAt = new Date();
    try {
      const result = await writeBackupFile({ now: attemptAt });
      await deleteOldBackups(settings.backupKeepCount);
      await Setting.updateOne({ key: "club" }, { $set: {
        lastBackupAt: result.createdAt, lastBackupFile: result.file, lastBackupAttemptAt: attemptAt, lastBackupError: null,
      } });
      return result;
    } catch (error) {
      await Setting.updateOne({ key: "club" }, { $set: { lastBackupAttemptAt: attemptAt, lastBackupError: error.message } }).catch(() => {});
      throw error;
    }
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

// When the next timed backup is due (null = backups are switched off)
function nextBackupDue(settings) {
  if (!settings.backupEnabled) return null;
  const intervalMs = settings.backupIntervalHours * 60 * 60 * 1000;
  let due = settings.lastBackupAt ? new Date(settings.lastBackupAt.getTime() + intervalMs) : new Date(0);
  if (settings.lastBackupError && settings.lastBackupAttemptAt) {
    const retry = new Date(settings.lastBackupAttemptAt.getTime() + RETRY_AFTER_FAILURE_MS);
    if (retry > due) due = retry;
  }
  return due;
}

// Called every minute by server.js. Also covers "the app was off": the first check after a start
// makes the backup at once when the last one is older than the chosen hours.
async function runScheduledBackupIfDue(now = new Date()) {
  if (running || mongoose.connection.readyState !== 1) return null;
  const due = nextBackupDue(await getSettings());
  if (!due || due > now) return null;
  const result = await runBackup();
  console.log(`Backup saved: ${result.path}`);
  return result;
}

// What the Settings page shows
async function backupStatus() {
  const settings = await getSettings();
  return {
    ...describeBackupFolder(),
    enabled: settings.backupEnabled,
    intervalHours: settings.backupIntervalHours,
    keepCount: settings.backupKeepCount,
    lastBackupAt: settings.lastBackupAt,
    lastBackupFile: settings.lastBackupFile,
    lastBackupAttemptAt: settings.lastBackupAttemptAt,
    lastBackupError: settings.lastBackupError,
    nextBackupAt: nextBackupDue(settings),
    running: Boolean(running),
    files: await listBackups(),
  };
}

// ---------- Restoring ----------

// Replaces every collection that is in the backup with the backup's records (raw MongoDB, so nothing
// is changed on the way in). Collections that aren't in the backup are left alone; all logins end.
async function restoreBackup(backup, db = mongoose.connection.db) {
  const counts = {};
  for (const { name, documents } of backup.collections) {
    const collection = db.collection(name);
    await collection.deleteMany({});
    for (let start = 0; start < documents.length; start += 1000) {
      await collection.insertMany(documents.slice(start, start + 1000), { ordered: true });
    }
    counts[name] = documents.length;
  }
  await db.collection("authsessions").deleteMany({});
  return counts;
}

module.exports = {
  FILE_PATTERN,
  documentToXml,
  parseBackupXml,
  readBackupFile,
  writeBackupFile,
  runBackup,
  runScheduledBackupIfDue,
  nextBackupDue,
  backupStatus,
  listBackups,
  backupFilePath,
  describeBackupFolder,
  restoreBackup,
};
