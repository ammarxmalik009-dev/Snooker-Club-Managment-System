// Automatic tests for the XML backups: backup -> restore gives back exactly the same records,
// damaged files are refused, the timer, the settings and the admin-only API.
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database
// and a temporary backup folder (never the club's real BACKUP_DIR).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Before anything reads .env: backups of this test go to a temporary folder
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "snooker-backup-test-"));
process.env.BACKUP_DIR = BACKUP_DIR;

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");
const backupService = require("../services/backup.service");
const { Setting } = require("../models/Setting");

const { ObjectId, Decimal128 } = mongoose.mongo;
const { EJSON } = mongoose.mongo.BSON;
const TEST_DB_URI = process.env.MONGODB_BACKUP_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_backup";

let server;
let baseUrl;
const cookies = {};

async function api(method, urlPath, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${urlPath}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a downloaded file */ }
  return { status: response.status, body: json, text, headers: response.headers };
}
const db = () => mongoose.connection.db;
const strict = (value) => EJSON.stringify(value, { relaxed: false });
const snapshot = async (name) => strict(await db().collection(name).find({}).sort({ _id: 1 }).toArray());
const resetBackupState = () => Setting.updateOne({ key: "club" }, { $set: {
  backupEnabled: true, backupIntervalHours: 12, backupKeepCount: 30, lastBackupAt: null, lastBackupFile: null, lastBackupAttemptAt: null, lastBackupError: null,
} }, { upsert: true });
const emptyBackupFolder = () => { for (const file of fs.readdirSync(BACKUP_DIR)) fs.unlinkSync(path.join(BACKUP_DIR, file)); };

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["admin", "staff", "cashier"]) cookies[role] = await loginAs(baseUrl, role);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await dropTestDatabase();
  await mongoose.disconnect();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

test("backup -> restore gives back exactly the same records (types, nesting, special text); logins are not saved", async () => {
  emptyBackupFolder();
  const tricky = {
    _id: new ObjectId(),
    name: "  Ali <Khan> & \"Sons\" 'Club'  ",
    urdu: "علی خان 🎱",
    control: "line\r\nbreak\u0001",
    empty: "",
    total: 50000, half: 12.5, negative: -3, zero: 0, paid: false, nothing: null,
    when: new Date("2026-10-10T15:30:00.123Z"),
    lines: [{ item: "Tea", qty: 2, by: new ObjectId() }, [1, [2, []]], null, "x"],
    emptyObject: {},
    money: Decimal128.fromString("10.50"),
  };
  await db().collection("bills").insertOne(tricky);
  await db().collection("extras").insertMany([{ name: "A" }, { name: "B" }]);
  const before = { bills: await snapshot("bills"), extras: await snapshot("extras"), users: await snapshot("users") };

  const result = await backupService.writeBackupFile();
  assert.match(result.file, backupService.FILE_PATTERN);
  assert.equal(result.counts.bills, 1);
  assert.equal(result.counts.extras, 2);
  assert.ok(!("authsessions" in result.counts), "login sessions are never in a backup");
  assert.deepEqual(fs.readdirSync(BACKUP_DIR), [result.file], "no .tmp file is left behind");
  const xml = fs.readFileSync(result.path, "utf8");
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<snookerBackup version="1"/);

  // The data changes after the backup ...
  await db().collection("bills").deleteMany({});
  await db().collection("extras").insertOne({ name: "C" });
  await db().collection("users").updateMany({}, { $set: { name: "Changed" } });

  // ... and the restore puts it back exactly
  const backup = await backupService.readBackupFile(result.path);
  await backupService.restoreBackup(backup);
  assert.equal(await snapshot("bills"), before.bills);
  assert.equal(await snapshot("extras"), before.extras);
  assert.equal(await snapshot("users"), before.users);
  assert.equal(await db().collection("authsessions").countDocuments(), 0, "everyone logs in again after a restore");

  for (const role of ["admin", "staff", "cashier"]) cookies[role] = await loginAs(baseUrl, role);
});

test("a damaged or unfinished backup file is refused and changes nothing", async () => {
  emptyBackupFolder();
  await db().collection("extras").deleteMany({});
  await db().collection("extras").insertMany([{ name: "A" }, { name: "B" }]);
  const { path: filePath } = await backupService.writeBackupFile();
  const xml = fs.readFileSync(filePath, "utf8");

  assert.throws(() => backupService.parseBackupXml(xml.slice(0, -30)), /damaged or incomplete/);
  assert.throws(() => backupService.parseBackupXml(xml.replace(/<doc>.*?<\/doc>\n/, "")), /incomplete: "\w+" should have/);
  assert.throws(() => backupService.parseBackupXml('<?xml version="1.0"?><other/>'), /not a Snooker Club Pro backup/);
  assert.equal(await db().collection("extras").countDocuments(), 2);
});

test("settings: backup on/off, every 1-168 hours, keep 1-365 files (admin only)", async () => {
  await resetBackupState();
  const saved = await api("PATCH", "/settings", { body: { backupEnabled: false, backupIntervalHours: 6, backupKeepCount: 10 } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.data.backupEnabled, saved.body.data.backupIntervalHours, saved.body.data.backupKeepCount], [false, 6, 10]);

  for (const body of [{ backupIntervalHours: 0 }, { backupIntervalHours: 169 }, { backupIntervalHours: 2.5 }, { backupKeepCount: 0 },
    { backupKeepCount: 366 }, { backupEnabled: "yes" }]) {
    const refused = await api("PATCH", "/settings", { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal((await api("PATCH", "/settings", { body: { backupIntervalHours: 3 }, cookie: cookies.staff })).status, 403);

  // The status fields are written by the backup service only
  const ignored = await api("PATCH", "/settings", { body: { backupIntervalHours: 12, lastBackupAt: "2020-01-01T00:00:00Z", lastBackupFile: "x.xml" } });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.data.lastBackupAt, null);
  assert.equal(ignored.body.data.lastBackupFile, null);
});

test("timer: due at once without a backup, then after the chosen hours; off = never; old files are deleted", async () => {
  emptyBackupFolder();
  await resetBackupState();
  const start = new Date();

  const first = await backupService.runScheduledBackupIfDue(start);
  assert.ok(first, "no backup yet -> made at the first check (also after the app was off)");
  assert.equal(await backupService.runScheduledBackupIfDue(new Date(start.getTime() + 60 * 1000)), null, "not again a minute later");

  const settings = await Setting.findOne({ key: "club" });
  assert.equal(settings.lastBackupFile, first.file);
  assert.equal(settings.lastBackupError, null);
  assert.equal(backupService.nextBackupDue(settings).getTime(), settings.lastBackupAt.getTime() + 12 * 60 * 60 * 1000);

  await Setting.updateOne({ key: "club" }, { $set: { backupIntervalHours: 1 } });
  assert.equal(backupService.nextBackupDue(await Setting.findOne({ key: "club" })).getTime(), settings.lastBackupAt.getTime() + 60 * 60 * 1000,
    "a new number of hours applies at once");

  await Setting.updateOne({ key: "club" }, { $set: { backupEnabled: false } });
  assert.equal(await backupService.runScheduledBackupIfDue(new Date(start.getTime() + 48 * 60 * 60 * 1000)), null, "switched off");

  // Keep the newest 2 "backup" files; a "before-restore" file is never deleted automatically
  await Setting.updateOne({ key: "club" }, { $set: { backupEnabled: true, backupKeepCount: 2 } });
  const safety = await backupService.writeBackupFile({ kind: "before-restore", now: new Date(start.getTime() - 1000) });
  for (let i = 1; i <= 3; i += 1) {
    await backupService.writeBackupFile({ now: new Date(start.getTime() - (5 + i) * 1000) }); // older files, different names
  }
  await new Promise((resolve) => setTimeout(resolve, 20)); // the newest file must have the newest time
  const newest = await backupService.runBackup();
  const left = (await backupService.listBackups()).map((backup) => backup.file);
  assert.equal(left.filter((file) => file.startsWith("snooker-backup-")).length, 2);
  assert.ok(left.includes(newest.file));
  assert.ok(left.includes(safety.file));
});

test("API: admin sees the status, makes a backup and downloads it; staff and cashier can't; bad names are 404", async () => {
  emptyBackupFolder();
  await resetBackupState();

  const status = await api("GET", "/backups");
  assert.equal(status.status, 200);
  assert.equal(status.body.data.folder, BACKUP_DIR);
  assert.equal(status.body.data.configured, true, "Step 38: this test always sets BACKUP_DIR explicitly, so the API must report it as configured");
  assert.equal(status.body.data.intervalHours, 12);
  assert.deepEqual(status.body.data.files, []);

  const made = await api("POST", "/backups");
  assert.equal(made.status, 201, made.text);
  const file = made.body.data.file;
  assert.match(made.body.message, /Backup saved/);

  const after = (await api("GET", "/backups")).body.data;
  assert.equal(after.lastBackupFile, file);
  assert.deepEqual(after.files.map((backup) => backup.file), [file]);
  assert.ok(new Date(after.nextBackupAt) > new Date(after.lastBackupAt));

  const download = await api("GET", `/backups/${file}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), new RegExp(file.replace(/\./g, "\\.")));
  assert.match(download.text, /<snookerBackup version="1"/);

  for (const role of ["staff", "cashier"]) {
    assert.equal((await api("GET", "/backups", { cookie: cookies[role] })).status, 403);
    assert.equal((await api("POST", "/backups", { cookie: cookies[role] })).status, 403);
    assert.equal((await api("GET", `/backups/${file}`, { cookie: cookies[role] })).status, 403);
  }
  assert.equal((await api("GET", "/backups", { cookie: null })).status, 401);

  for (const bad of ["..%2F..%2F.env", "snooker-backup-2026-10-10_21-00-00.xml", "notes.txt", "%2E%2E%5Cpackage.json"]) {
    assert.equal((await api("GET", `/backups/${bad}`)).status, 404, bad);
  }
});
