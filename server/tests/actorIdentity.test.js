// Tests for the Phase 3 identity-compatibility change: models/schemas/actor.js's `user` field
// (and AuthSession.js's own copy of the same change) now accepts a real MongoDB ObjectId OR a
// PostgreSQL UUID, instead of only a strict Mongoose ObjectId. See docs/POSTGRES_MIGRATION.md's
// Phase 3 Group 2 blocker-resolution report for the full design and evidence.
//
// This is schema/validator compatibility work only - PostgreSQL Users/Auth is NOT activated by
// this change (confirmed in test D5/the isolation note below), and nothing here claims MongoDB
// and PostgreSQL sessions are interchangeable (see test C3's own comment).
//
// Needs the real MongoDB test database (npm run db) - the same as every other server test file,
// not the optional PostgreSQL pilot infrastructure.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb");
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");

const TEST_DB_URI = process.env.MONGODB_ACTORIDENTITY_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_actoridentity";

let server;
let baseUrl;
const cookies = {};

async function api(method, path, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: { Cookie: cookie } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 }).catch((error) => {
    throw new Error(`MongoDB is not running (start it with: npm run db). ${error.message}`);
  });
  await dropTestDatabase();
  await mongoose.connection.syncIndexes();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cookies.admin = await loginAs(baseUrl, "admin");
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await dropTestDatabase();
  await mongoose.disconnect();
});

const REAL_UUID = "123e4567-e89b-12d3-a456-426614174000"; // valid format, matches no real user - that's fine, this only proves the FORMAT is accepted

// ---------------------------------------------------------------------------
// A. Actor schema: both identity formats, required/invalid behaviour unchanged
// ---------------------------------------------------------------------------

test("A1. actorSchema accepts a real MongoDB ObjectId for `user`, and round-trips it unchanged", async () => {
  const { Category } = require("../models/Category");
  const oid = new mongoose.Types.ObjectId();
  const doc = await Category.create({ name: "ObjectId Actor Test", createdBy: { user: oid, name: "Ali", username: "ali" }, updatedBy: { user: oid, name: "Ali", username: "ali" } });
  const reread = await Category.findById(doc._id);
  assert.equal(reread.createdBy.user, oid.toString());
  assert.equal(typeof reread.createdBy.user, "string");
  assert.equal(reread.createdBy.name, "Ali");
  assert.equal(reread.createdBy.username, "ali");
});

test("A2. actorSchema accepts a valid PostgreSQL-shaped UUID for `user`", async () => {
  const { Category } = require("../models/Category");
  const doc = await Category.create({ name: "UUID Actor Test", createdBy: { user: REAL_UUID, name: "Pg Admin", username: "pg.admin" }, updatedBy: { user: REAL_UUID, name: "Pg Admin", username: "pg.admin" } });
  const reread = await Category.findById(doc._id);
  assert.equal(reread.createdBy.user, REAL_UUID);
});

test("A3. a missing `user` is still rejected - required was not weakened", async () => {
  const { Category } = require("../models/Category");
  await assert.rejects(
    Category.create({ name: "Missing User Test", createdBy: { name: "No User", username: "nouser" } }),
    (error) => { assert.match(error.message, /user/i); return true; }
  );
});

test("A4. a malformed `user` (neither an ObjectId nor a UUID) is rejected", async () => {
  const { Category } = require("../models/Category");
  await assert.rejects(
    Category.create({ name: "Malformed User Test", createdBy: { user: "not-a-valid-id", name: "Bad", username: "bad" } }),
    (error) => { assert.match(error.message, /valid id/i); return true; }
  );
});

test("A5. name/username are still required - unchanged by this identity change", async () => {
  const { Category } = require("../models/Category");
  await assert.rejects(Category.create({ name: "Missing Name Test", createdBy: { user: REAL_UUID, username: "x" } }));
  await assert.rejects(Category.create({ name: "Missing Username Test", createdBy: { user: REAL_UUID, name: "x" } }));
});

// Representative real models beyond Category - E. Model coverage note: every actor-bearing
// model (Bill, Booking, CafeOrder, Category, Match, Payment, Player, Product, Session, Setting,
// StockMovement, User - 12 in total, confirmed by searching the codebase for `actorSchema`)
// embeds the EXACT SAME shared sub-schema tested directly above (A1-A5) - there is no per-model
// copy of the validation logic to diverge. Player and Setting are tested here too, end-to-end
// through their own real model files, specifically to confirm this isn't only a property of the
// shared schema in isolation but actually works through real, independently-loaded model
// modules. The other 9 are not re-tested individually: doing so would repeat the same assertion
// against the same shared schema object 9 more times, not exercise any new code path.
test("A6. Player and Setting (representative real models) accept a UUID actor the same way", async () => {
  const { Player } = require("../models/Player");
  const player = await Player.create({ name: "Representative Player", nameKey: "representative player", createdBy: { user: REAL_UUID, name: "Pg Admin", username: "pg.admin" }, updatedBy: { user: REAL_UUID, name: "Pg Admin", username: "pg.admin" } });
  assert.equal(player.createdBy.user, REAL_UUID);

  const { Setting } = require("../models/Setting");
  const setting = await Setting.findOneAndUpdate({ key: "club" }, { $setOnInsert: { key: "club" } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
  setting.updatedBy = { user: REAL_UUID, name: "Pg Admin", username: "pg.admin" };
  await setting.save();
  const rereadSetting = await Setting.findById(setting._id);
  assert.equal(rereadSetting.updatedBy.user, REAL_UUID);
});

// ---------------------------------------------------------------------------
// B. Historical compatibility: a document written exactly as the OLD strict-ObjectId schema
// would have produced it (a raw BSON ObjectId, inserted via the native driver, bypassing
// Mongoose entirely) must still load correctly under the NEW schema.
// ---------------------------------------------------------------------------

test("B1. a historical, pre-existing ObjectId-shaped actor document remains readable and valid", async () => {
  const { Category } = require("../models/Category");
  const historicalActorId = new mongoose.Types.ObjectId();
  const insertResult = await mongoose.connection.db.collection("categories").insertOne({
    name: "Historical Category",
    nameKey: "historical category",
    createdBy: { user: historicalActorId, name: "Old Admin", username: "old.admin" }, // a REAL ObjectId, as every document written before this change has
    updatedBy: { user: historicalActorId, name: "Old Admin", username: "old.admin" },
    createdAt: new Date(), updatedAt: new Date(),
  });

  const loaded = await Category.findById(insertResult.insertedId);
  assert.ok(loaded, "the historical document loads without error under the new schema");
  assert.equal(loaded.createdBy.user, historicalActorId.toString(), "the ObjectId value is preserved exactly, just read back as a string");
  assert.equal(loaded.createdBy.name, "Old Admin");
  // The loaded document must also still pass full validation (not just loading) - proving this
  // isn't merely tolerated on read but genuinely considered a valid document going forward too.
  await assert.doesNotReject(loaded.validate());
});

// ---------------------------------------------------------------------------
// C. AuthSession: the same identity-compatibility change, and the real MongoDB lifecycle
// ---------------------------------------------------------------------------

test("C1. AuthSession's normal MongoDB lifecycle (create, lookup, expiry query) is unaffected", async () => {
  const { AuthSession } = require("../models/AuthSession");
  const { User } = require("../models/User");
  const user = await User.findOne({ username: "test-admin" }); // created by loginAs() in test.before
  const session = await AuthSession.create({
    tokenHash: "a".repeat(64),
    user: user._id,
    expiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
  });
  assert.equal(typeof session.user, "string");
  assert.equal(session.user, user._id.toString());

  const found = await AuthSession.findOne({ tokenHash: "a".repeat(64), expiresAt: { $gt: new Date() } });
  assert.ok(found, "the real expiry-checked lookup auth.service.js's own resolveSession makes still works");
});

test("C2. AuthSession invalidation (deleteMany by user) still works, unchanged", async () => {
  // A dedicated, throwaway user - NOT "test-admin", whose own real login session (created once
  // in test.before()) the D-tests below still need. Deleting every session for a shared user
  // here would silently log out the fixture every other test in this file depends on - a real
  // bug found and fixed while verifying this file, not a hidden production issue.
  const { AuthSession } = require("../models/AuthSession");
  const { createUser } = require("../services/users.service");
  const throwaway = await createUser({ name: "Throwaway User", username: "throwaway.c2", role: "staff", password: "Throwaway-Pass-123" });
  await AuthSession.create({ tokenHash: "b".repeat(64), user: throwaway._id, expiresAt: new Date(Date.now() + 3600_000) });
  await AuthSession.deleteMany({ user: throwaway._id });
  assert.equal(await AuthSession.countDocuments({ user: throwaway._id }), 0);
});

test("C3. a UUID-shaped session value is now schema-valid - but this does NOT mean MongoDB and PostgreSQL sessions are interchangeable", async () => {
  const { AuthSession } = require("../models/AuthSession");
  // Schema-level acceptance only - proven directly, not assumed:
  const session = new AuthSession({ tokenHash: "c".repeat(64), user: REAL_UUID, expiresAt: new Date(Date.now() + 3600_000) });
  await assert.doesNotReject(session.validate());
  await session.save();
  await session.deleteOne();
  // What this does NOT prove, and is not claimed anywhere in this change: that
  // auth.service.js's own resolveSession (`User.findById(session.user)`) would succeed for such
  // a session - that specific MongoDB query requires a real MongoDB ObjectId regardless of this
  // schema's own type, and auth.service.js itself was deliberately not changed in this step.
  // Making cross-backend sessions actually resolve is separate, future, business-logic work.
});

// ---------------------------------------------------------------------------
// D. The user-id HTTP validator: both formats accepted for /api/users/:id and
// /api/users/:id/password; a malformed id still rejected; unrelated resource validators
// (confirmed via a real, different route) are untouched.
// ---------------------------------------------------------------------------

test("D1. GET /api/users/:id with a real MongoDB ObjectId still works exactly as before", async () => {
  const { User } = require("../models/User");
  const admin = await User.findOne({ username: "test-admin" });
  const result = await api("GET", `/users/${admin._id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.username, "test-admin");
});

test("D2. GET /api/users/:id with a valid-format UUID passes the id-FORMAT check (no longer refused as \"Invalid user id\")", async () => {
  const result = await api("GET", `/users/${REAL_UUID}`);
  assert.notEqual(result.body.message, "Invalid user id");
  // What happens next (no matching MongoDB user exists in this format) is a SEPARATE, expected
  // consequence of PostgreSQL Users/Auth not being activated - not something this step fixes or
  // claims to fix. Confirmed here only as evidence the validator itself did not block it.
  assert.notEqual(result.status, undefined);
});

test("D3. a genuinely malformed user id is still rejected, with the same message as before", async () => {
  const result = await api("GET", "/users/not-a-valid-id");
  assert.equal(result.status, 400);
  assert.equal(result.body.message, "Invalid user id");
});

test("D4. POST /api/users/:id/password also accepts both formats at the validator level (passwordRules spreads the same idRules)", async () => {
  const objectIdResult = await api("POST", `/users/${new mongoose.Types.ObjectId()}/password`, { body: { password: "Totally-Valid-Pass-1" } });
  assert.notEqual(objectIdResult.body.message, "Invalid user id"); // a well-FORMED id that simply doesn't exist -> 404, not a format rejection
  const uuidResult = await api("POST", `/users/${REAL_UUID}/password`, { body: { password: "Totally-Valid-Pass-1" } });
  assert.notEqual(uuidResult.body.message, "Invalid user id");
  const malformedResult = await api("POST", "/users/not-a-valid-id/password", { body: { password: "Totally-Valid-Pass-1" } });
  assert.equal(malformedResult.status, 400);
  assert.equal(malformedResult.body.message, "Invalid user id");
});

test("D5. an UNRELATED resource's id validator is unchanged: GET /api/tables/:id still refuses a UUID with its own message", async () => {
  const result = await api("GET", `/tables/${REAL_UUID}`);
  assert.equal(result.status, 400);
  assert.equal(result.body.message, "Invalid table id"); // tables.validators.js's own idRules, untouched - still plain .isMongoId()
});

// ---------------------------------------------------------------------------
// F. identityOf precedence - the explicit, documented rule from Phase 3's integration
// foundation work: prefer `user.id` (a non-empty string) over `user._id`. Tested directly
// (pure function, no database needed) against BOTH copies - models/schemas/actor.js's own and
// db/rowMappers.js's small, local, mongoose-free copy for the PostgreSQL pilots - to confirm
// they agree, the same way this project already checks nameKeyOf's two copies agree.
// ---------------------------------------------------------------------------

test("F1. identityOf prefers a MongoDB document's own `.id` virtual over `._id` - and the two are always the same value anyway", () => {
  const { identityOf } = require("../models/schemas/actor");
  const oid = new mongoose.Types.ObjectId();
  // A REAL Mongoose document (not a hand-built plain object) - has both properties for real,
  // confirmed directly, not assumed.
  const { Category } = require("../models/Category");
  const doc = new Category({ name: "Identity Precedence Test" });
  doc._id = oid;
  assert.equal(doc.id, oid.toString(), "Mongoose's own .id virtual always equals String(_id)");
  assert.equal(identityOf(doc), oid.toString());
});

test("F2. identityOf uses a PostgreSQL-shaped object's only property, `.id`", () => {
  const { identityOf } = require("../models/schemas/actor");
  assert.equal(identityOf({ id: REAL_UUID, name: "Pg Admin", username: "pg.admin" }), REAL_UUID);
});

test("F3. identityOf: an object with BOTH properties uses `.id`, never the (hypothetically different) `._id`", () => {
  const { identityOf } = require("../models/schemas/actor");
  // Deliberately DIFFERENT values, to prove the precedence rule actually picks one and not the
  // other - a real Mongoose document never has this mismatch (confirmed in F1), but the rule
  // itself must still be unambiguous for any object shaped this way.
  assert.equal(identityOf({ id: "id-value", _id: "underscore-id-value" }), "id-value");
});

test("F4. identityOf falls back to `._id` only when `.id` is missing or an empty string", () => {
  const { identityOf } = require("../models/schemas/actor");
  assert.equal(identityOf({ _id: "fallback-value" }), "fallback-value");
  assert.equal(identityOf({ id: "", _id: "fallback-value" }), "fallback-value", "an empty string id is not usable - falls back");
});

test("F5. identityOf returns undefined (never a fabricated value) when neither property is usable - actorFrom's own `required: true` then catches it", () => {
  const { identityOf, actorFrom } = require("../models/schemas/actor");
  assert.equal(identityOf({ name: "No Id At All" }), undefined);
  const actor = actorFrom({ name: "No Id At All", username: "no.id" });
  assert.equal(actor.user, undefined, "never silently invented - undefined, so the schema's required check genuinely fires");
});

test("F6. rowMappers.js's own identityOf/actorFrom (the PostgreSQL pilots' mongoose-free copy) agree with models/schemas/actor.js's own, for the same representative inputs", () => {
  const schemaActor = require("../models/schemas/actor");
  const pgRowMapper = require("../db/rowMappers");
  const inputs = [
    { id: "pg-uuid-value", name: "A", username: "a" },
    { _id: "mongo-object-id-value", name: "B", username: "b" },
    { id: "", _id: "fallback-value", name: "C", username: "c" },
    { name: "D", username: "d" }, // neither id nor _id
  ];
  for (const input of inputs) {
    assert.equal(schemaActor.identityOf(input), pgRowMapper.identityOf(input), JSON.stringify(input));
    assert.deepEqual(schemaActor.actorFrom(input), pgRowMapper.actorFrom(input), JSON.stringify(input));
  }
});

test("F7. actorFrom + a real model write: a PostgreSQL-shaped actor (id only, no _id) serializes and reads back exactly as test A2 already proved - this time via actorFrom() itself, not a hand-built object", async () => {
  const { actorFrom } = require("../models/schemas/actor");
  const { Category } = require("../models/Category");
  const pgShapedUser = { id: REAL_UUID, name: "Pg Admin Via ActorFrom", username: "pg.admin.actorfrom" };
  const actor = actorFrom(pgShapedUser);
  assert.equal(actor.user, REAL_UUID, "actorFrom itself now produces the correct identity for a PostgreSQL-shaped user");
  const doc = await Category.create({ name: "ActorFrom PG Test", createdBy: actor, updatedBy: actor });
  const reread = await Category.findById(doc._id);
  assert.equal(reread.createdBy.user, REAL_UUID);
});
