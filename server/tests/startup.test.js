// Tests for Phase 11.8: the server's start-up messages about the database.
//  - "can't connect" and "connected, but the index update failed" are told apart
//  - the hint is the project's own MongoDB (npm run db), not a Windows service
//  - the MONGODB_URI is never printed whole: no user name, password or options

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { connectToDatabase, disconnectFromDatabase, safeMongoTarget, safeErrorMessage, databaseStartupMessage } = require("../config/db");

const TEST_DB_URI = process.env.MONGODB_STARTUP_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_startup";
const SECRET_URI = "mongodb://clubadmin:S3cret-Pa55@db.example.local:27017/snooker_club_pro?authSource=admin&tls=true";

test("the database address is printed without user name, password or options", () => {
  assert.equal(safeMongoTarget(SECRET_URI), "db.example.local:27017/snooker_club_pro");
  assert.equal(safeMongoTarget("mongodb://127.0.0.1:27017/snooker_club_pro"), "127.0.0.1:27017/snooker_club_pro");
  assert.equal(safeMongoTarget("mongodb+srv://u:p@cluster0.example.net/club"), "cluster0.example.net/club");
  assert.equal(safeMongoTarget("not a uri"), "(the address in MONGODB_URI)");
  // An error that quotes the URI (or any "user:password@") is cleaned
  const message = safeErrorMessage(new Error(`bad auth for ${SECRET_URI} and mongodb://other:pw@host/x`), SECRET_URI);
  assert.ok(!message.includes("S3cret-Pa55") && !message.includes("clubadmin") && !message.includes("other:pw"), message);
  assert.ok(message.includes("db.example.local:27017/snooker_club_pro") && message.includes("mongodb://***@host/x"), message);
});

test("can't connect: says so, points to 'npm.cmd run db', never the full URI", async () => {
  const unreachable = "mongodb://clubadmin:S3cret-Pa55@127.0.0.1:1/snooker_club_pro_test_startup_nowhere";
  const error = await connectToDatabase({ uri: unreachable, timeoutMS: 500 }).then(() => null, (e) => e);
  assert.ok(error, "the connection must fail");
  assert.equal(error.stage, "connect");
  const lines = databaseStartupMessage(error, unreachable);
  assert.match(lines[0], /^Could not connect to MongoDB \(127\.0\.0\.1:1\/snooker_club_pro_test_startup_nowhere\): /);
  assert.ok(lines.some((line) => line.includes("npm.cmd run db")));
  assert.ok(!lines.join("\n").includes("Services") && !lines.join("\n").includes("S3cret-Pa55") && !lines.join("\n").includes("clubadmin"));
  await disconnectFromDatabase();
});

test("connected but the index update failed: reported as that, not as 'could not connect'", async () => {
  const realSync = mongoose.connection.syncIndexes;
  mongoose.connection.syncIndexes = async () => { throw new Error("E11000 duplicate key error collection: x index: one_bill_per_session_or_match"); };
  try {
    const error = await connectToDatabase({ uri: TEST_DB_URI, timeoutMS: 3000 }).then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.stage, "indexes");
    assert.equal(mongoose.connection.readyState, 1, "the connection itself worked");
    const lines = databaseStartupMessage(error, TEST_DB_URI);
    assert.match(lines[0], /^MongoDB connected \(127\.0\.0\.1:27017\/snooker_club_pro_test_startup\), but updating the database indexes failed: E11000/);
    assert.ok(!lines.join("\n").includes("Could not connect"));
    assert.ok(lines.some((line) => line.includes("No data was changed")));
  } finally {
    mongoose.connection.syncIndexes = realSync;
    if (mongoose.connection.readyState === 1) await dropTestDatabase();
    await disconnectFromDatabase();
  }
});

test("connected but the index sync failed because of low disk space: told apart from a duplicate-data failure, never blamed on bad data", async () => {
  const realSync = mongoose.connection.syncIndexes;
  // The exact wording MongoDB 7.1+'s indexBuildMinAvailableDiskSpaceMB check uses - a real
  // server-side safety check, confirmed against a matching real-world report of this same
  // failure on a small Railway-hosted MongoDB volume, not a guess at the wording.
  mongoose.connection.syncIndexes = async () => {
    throw new Error("Index build: available disk space is approximately 23391864 bytes, below the required minimum of 52428800 bytes");
  };
  try {
    const error = await connectToDatabase({ uri: TEST_DB_URI, timeoutMS: 3000 }).then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.stage, "indexes");
    const lines = databaseStartupMessage(error, TEST_DB_URI);
    assert.match(lines[0], /enough free disk space/);
    assert.ok(!lines.join("\n").includes("existing records break its rule"), "must never show the duplicate-data message for a disk-space failure");
    assert.ok(lines.some((line) => /NOT a duplicate-data problem/i.test(line)), "should actively reassure, not just omit the duplicate explanation");
    assert.ok(lines.some((line) => /volume|free space/i.test(line) && /increase|free/i.test(line)));
  } finally {
    mongoose.connection.syncIndexes = realSync;
    if (mongoose.connection.readyState === 1) await dropTestDatabase();
    await disconnectFromDatabase();
  }
});
