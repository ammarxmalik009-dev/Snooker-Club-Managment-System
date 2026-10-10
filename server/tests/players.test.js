// Automatic tests for Phase 11.2: registered players (/api/players).
// Run with: npm test   (MongoDB must be running: npm run db). Uses its own throw-away database.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { dropTestDatabase } = require("./helpers/testDb"); // refuses any database without "test" in its name
const { createApp } = require("../app");
const { loginAs } = require("./helpers/auth");

const TEST_DB_URI = process.env.MONGODB_PLAYERS_TEST_URI || "mongodb://127.0.0.1:27017/snooker_club_pro_test_players";

let server;
let baseUrl;
const cookies = {};

async function api(method, path, { body, cookie = cookies.admin } = {}) {
  const options = { method, headers: {} };
  if (cookie) options.headers.Cookie = cookie;
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, options);
  return { status: response.status, body: await response.json().catch(() => null) };
}
const ok = async (method, path, options) => {
  const result = await api(method, path, options);
  assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
};
const db = () => mongoose.connection;
const clear = () => db().collection("players").deleteMany({});

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
});

test("create: name tidied, optional phone and notes, audit, no internal or counter fields", async () => {
  await clear();
  const player = await ok("POST", "/players", { body: { name: "  Ali   Khan ", phone: " 0300-1234567 ", notes: "Plays on Fridays" }, cookie: cookies.staff });
  assert.deepEqual([player.name, player.phone, player.notes, player.isActive, player.deactivatedAt], ["Ali Khan", "0300-1234567", "Plays on Fridays", true, null]);
  assert.equal(player.createdBy.username, "test-staff");
  assert.equal(player.updatedBy.username, "test-staff");
  assert.ok(player.createdAt && player.updatedAt);
  for (const hidden of ["nameKey", "phoneDigits", "_id", "__v", "wins", "losses", "gamesPlayed", "spending", "outstanding", "customer"]) {
    assert.ok(!(hidden in player), `${hidden} is not part of a player`);
  }
  const minimal = await ok("POST", "/players", { body: { name: "Bilal" } });
  assert.deepEqual([minimal.phone, minimal.notes], ["", ""], "phone and notes are optional");
  // Stored keys used for uniqueness and search
  const stored = await db().collection("players").findOne({ name: "Ali Khan" });
  assert.deepEqual([stored.nameKey, stored.phoneDigits], ["ali khan", "03001234567"]);
});

test("validation: name, phone and notes rules", async () => {
  await clear();
  const bad = async (body, message) => {
    const { status, body: res } = await api("POST", "/players", { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(res), message);
  };
  await bad({}, /Player name is required/);
  await bad({ name: "   " }, /Name must be 2 to 60 characters/);
  await bad({ name: "A" }, /Name must be 2 to 60 characters/);
  await bad({ name: "x".repeat(61) }, /Name must be 2 to 60 characters/);
  await bad({ name: 42 }, /Name must be text/);
  await bad({ name: "Ali", phone: "abc" }, /Phone must be 7 to 20 digits/);
  await bad({ name: "Ali", phone: "123" }, /Phone must be 7 to 20 digits/);
  await bad({ name: "Ali", notes: "n".repeat(201) }, /Notes must be at most 200 characters/);
  assert.equal(await db().collection("players").countDocuments(), 0);
});

test("duplicates: registered names are unique ignoring capitals and spaces - also against inactive players", async () => {
  await clear();
  const ali = await ok("POST", "/players", { body: { name: "Ali" } });
  for (const name of ["ali", "ALI", "  Ali ", "ali"]) {
    const { status, body } = await api("POST", "/players", { body: { name } });
    assert.equal(status, 409, name);
    assert.equal(body.message, 'A player called "Ali" is already registered');
    assert.deepEqual(body.errors, [{ field: "name", message: 'A player called "Ali" is already registered' }]);
  }
  // Similar but different names are different people (nothing is guessed)
  await ok("POST", "/players", { body: { name: "Ali Raza" } });
  await ok("POST", "/players", { body: { name: "Aly" } });
  // Inactive players still own their name
  await ok("POST", `/players/${ali.id}/deactivate`);
  const again = await api("POST", "/players", { body: { name: "ALI" } });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /inactive - reactivate them instead/);
  // Two at the same moment: the database's unique index lets only one in
  const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", "/players", { body: { name: "Same Moment" } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
});

test("update: partial changes, renames, duplicate on rename, active state only via its own endpoints", async () => {
  await clear();
  const ali = await ok("POST", "/players", { body: { name: "Ali", phone: "0300-1234567", notes: "Left-handed" } });
  await ok("POST", "/players", { body: { name: "Usman" } });
  const renamed = await ok("PATCH", `/players/${ali.id}`, { body: { name: "ALI" }, cookie: cookies.staff }); // same name, other capitals
  assert.deepEqual([renamed.name, renamed.phone, renamed.notes], ["ALI", "0300-1234567", "Left-handed"], "other fields kept");
  assert.equal(renamed.updatedBy.username, "test-staff");
  const dup = await api("PATCH", `/players/${ali.id}`, { body: { name: " usman " } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.message, 'A player called "Usman" is already registered');
  const cleared = await ok("PATCH", `/players/${ali.id}`, { body: { phone: "", notes: "" } });
  assert.deepEqual([cleared.phone, cleared.notes, cleared.name], ["", "", "ALI"]);
  const activeEdit = await api("PATCH", `/players/${ali.id}`, { body: { isActive: false } });
  assert.equal(activeEdit.status, 400);
  assert.equal(activeEdit.body.message, "Use Deactivate or Reactivate to change whether a player is active");
  assert.equal((await api("PATCH", `/players/${ali.id}`, { body: {} })).status, 400);
  assert.equal((await api("PATCH", "/players/0123456789abcdef01234567", { body: { name: "Nobody" } })).status, 404);
  assert.equal((await api("GET", "/players/not-an-id")).status, 400);
});

test("deactivate / reactivate: never deleted, history-safe", async () => {
  await clear();
  const ali = await ok("POST", "/players", { body: { name: "Ali" } });
  const off = await ok("POST", `/players/${ali.id}/deactivate`);
  assert.equal(off.isActive, false);
  assert.ok(off.deactivatedAt);
  assert.equal((await api("POST", `/players/${ali.id}/deactivate`)).status, 409, "already inactive");
  const on = await ok("POST", `/players/${ali.id}/reactivate`);
  assert.deepEqual([on.isActive, on.deactivatedAt], [true, null]);
  assert.equal((await api("POST", `/players/${ali.id}/reactivate`)).status, 409, "already active");
  // There is no delete
  const del = await api("DELETE", `/players/${ali.id}`);
  assert.equal(del.status, 404);
  assert.equal(await db().collection("players").countDocuments({ _id: new mongoose.Types.ObjectId(ali.id) }), 1);
});

test("list and search: by name or phone digits, active/inactive/all, paging", async () => {
  await clear();
  const names = ["Ahmed", "Ali Khan", "Bilal", "Saad", "Zain"];
  const created = {};
  for (const [i, name] of names.entries()) created[name] = await ok("POST", "/players", { body: { name, phone: `0300-55500${i}0` } });
  await ok("POST", `/players/${created.Zain.id}/deactivate`);
  const list = async (q) => (await ok("GET", `/players?${q}`));
  assert.deepEqual((await list("")).players.map((p) => p.name), ["Ahmed", "Ali Khan", "Bilal", "Saad"], "active by default, sorted by name");
  assert.deepEqual((await list("status=inactive")).players.map((p) => p.name), ["Zain"]);
  assert.equal((await list("status=all")).total, 5);
  assert.deepEqual((await list("search=khan")).players.map((p) => p.name), ["Ali Khan"]);
  assert.deepEqual((await list("search=a")).players.map((p) => p.name), ["Ahmed", "Ali Khan", "Bilal", "Saad"]);
  assert.deepEqual((await list("search=555 0020")).players.map((p) => p.name), ["Bilal"], "phone digits, any format");
  const page2 = await list("limit=2&page=2");
  assert.deepEqual([page2.players.map((p) => p.name), page2.total, page2.totalPages], [["Bilal", "Saad"], 4, 2]);
  assert.equal((await api("GET", "/players?status=gone")).status, 400);
});

test("permissions: view all roles; register/edit admin+staff; deactivate admin; logged out 401", async () => {
  await clear();
  const p = await ok("POST", "/players", { body: { name: "Ali" } });
  const checks = [
    ["GET", "/players", undefined, [200, 200, 200]],
    ["GET", `/players/${p.id}`, undefined, [200, 200, 200]],
    ["POST", "/players", (role) => ({ name: `New ${role}` }), [201, 201, 403]],
    ["PATCH", `/players/${p.id}`, () => ({ notes: "x" }), [200, 200, 403]],
    ["POST", `/players/${p.id}/deactivate`, undefined, [200, 403, 403]],
  ];
  for (const [method, path, body, expected] of checks) {
    const statuses = [];
    for (const role of ["admin", "staff", "cashier"]) {
      statuses.push((await api(method, path, { body: typeof body === "function" ? body(role) : body, cookie: cookies[role] })).status);
      if (path.endsWith("/deactivate")) await api("POST", `/players/${p.id}/reactivate`); // reset for the next role
    }
    assert.deepEqual(statuses, expected, `${method} ${path}`);
    assert.equal((await api(method, path, { body: typeof body === "function" ? body("x") : body, cookie: null })).status, 401);
  }
  // The Players page: every role may open it
  for (const role of ["admin", "staff", "cashier"]) {
    const page = await fetch(`${baseUrl}/pages/players.html`, { headers: { Cookie: cookies[role] }, redirect: "manual" });
    assert.equal(page.status, 200, role);
  }
});

test("players and customers stay separate: nothing is created or linked automatically", async () => {
  await clear();
  await db().collection("customers").deleteMany({});
  await ok("POST", "/players", { body: { name: "Ali Raza", phone: "0300-1234567" } });
  assert.equal(await db().collection("customers").countDocuments(), 0, "registering a player creates no customer");
  await ok("POST", "/customers", { body: { name: "Bilal", phone: "0300-7654321" } });
  assert.equal(await db().collection("players").countDocuments({ nameKey: "bilal" }), 0, "a customer is not turned into a player");
  // Same name as a customer is allowed for a player (they are different records)
  await ok("POST", "/players", { body: { name: "Bilal" } });
  const player = await db().collection("players").findOne({ nameKey: "bilal" });
  assert.ok(!("customer" in player), "no customer link");
});
