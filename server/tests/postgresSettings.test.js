// Tests for the PostgreSQL row-mapper layer and the Settings service pilot (Phase 2, step 2.4 -
// see docs/POSTGRES_MIGRATION.md). Like the other server/tests/postgres*.test.js files, this is
// the ONLY file that touches these new modules; every MongoDB test (including the ones that
// read/write Settings through server/services/settings.service.js) is completely unaffected -
// this file never requires "mongoose" or anything under server/models/.
//
// The row-mapper unit tests (no database) always run. The service tests need
// PG_TEST_DATABASE_URL (server/tests/helpers/testDb.pg.js) and refuse anything but the verified
// local instance (127.0.0.1:5433, step 2.2A) - SKIPPED with a clear reason otherwise.

const test = require("node:test");
const assert = require("node:assert/strict");
const { toMoney, snakeToCamel, toId, actorFromRow, actorFrom } = require("../db/rowMappers");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

// ---------- Row-mapper unit tests (no database, no PostgreSQL needed) ----------

test("toMoney: PostgreSQL bigint-as-string -> number; null stays null (never set, not zero)", () => {
  assert.equal(toMoney("1000"), 1000);
  assert.equal(typeof toMoney("1000"), "number");
  assert.equal(toMoney("0"), 0); // 0 = "explicitly switched off" (Setting.js) - never becomes null
  assert.equal(toMoney("10000000"), 10000000); // MAX_PRICE: exact, no precision loss
  assert.equal(toMoney(null), null); // null = "never set" - never becomes 0
  assert.equal(toMoney(undefined), null);
});

test("snakeToCamel: ordinary column names only, not nested/renamed ones", () => {
  assert.equal(snakeToCamel("minimum_billable_minutes"), "minimumBillableMinutes");
  assert.equal(snakeToCamel("tax_enabled"), "taxEnabled");
  assert.equal(snakeToCamel("id"), "id");
  assert.equal(snakeToCamel("currency"), "currency");
});

test("toId: uuid columns pass through as strings; null/undefined -> null", () => {
  assert.equal(toId("d5bd940f-8e1d-4a4f-9500-024f8e3c9215"), "d5bd940f-8e1d-4a4f-9500-024f8e3c9215");
  assert.equal(toId(null), null);
  assert.equal(toId(undefined), null);
});

test("actorFromRow: flattened <prefix>_user_id/_name/_username columns -> { user, name, username }, or null", () => {
  assert.deepEqual(
    actorFromRow({ updated_by_user_id: "abc", updated_by_name: "Sara", updated_by_username: "sara" }, "updated_by"),
    { user: "abc", name: "Sara", username: "sara" }
  );
  assert.equal(actorFromRow({ updated_by_user_id: null, updated_by_name: null, updated_by_username: null }, "updated_by"), null);
  // The real gap this pilot has until Phase 3 ports Users: the id is unknown (a Mongo ObjectId,
  // not a Postgres uuid) but the name/username ARE known - must not be thrown away.
  assert.deepEqual(
    actorFromRow({ updated_by_user_id: null, updated_by_name: "Sara", updated_by_username: "sara" }, "updated_by"),
    { user: null, name: "Sara", username: "sara" }
  );
});

test("actorFrom: a logged-in user -> { user, name, username }; no user -> null", () => {
  assert.deepEqual(actorFrom({ _id: "652f1c2e8a1b2c3d4e5f6071", name: "Admin Owner", username: "owner" }),
    { user: "652f1c2e8a1b2c3d4e5f6071", name: "Admin Owner", username: "owner" });
  assert.equal(actorFrom(null), null);
});

// ---------- Settings service pilot (needs the real local PostgreSQL) ----------

const TEST_URL = getPgTestDatabaseUrl(); // null = not configured; never falls back to DATABASE_URL
if (TEST_URL) process.env.DATABASE_URL = TEST_URL; // read by server/config/env.js when required below

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.4: running the settings pilot tests") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Settings pilot: defaults, updates, concurrency, validation, isolation from MongoDB", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const settingsPg = require("../services/settings.pg.service");

  // See testDb.pg.js: several postgres*.test.js files share this "app" schema, and test files
  // run in parallel by default - this blocks until any other such file's run has fully finished.
  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // start clean
  await migrate.runMigrations(); // the real 0001_initial_schema.sql - no shortcuts

  await t.test("creating/initializing: the first read creates exactly one default row", async () => {
    const before = await getPool().query("SELECT count(*)::int AS n FROM app.settings");
    assert.equal(before.rows[0].n, 0);

    const settings = await settingsPg.getSettings();
    assert.equal(settings.key, "club");
    assert.match(settings.id, /^[0-9a-f-]{36}$/);

    const after = await getPool().query("SELECT count(*)::int AS n FROM app.settings");
    assert.equal(after.rows[0].n, 1);
  });

  await t.test("read behaviour: stored defaults match models/Setting.js exactly", async () => {
    const settings = await settingsPg.getSettings();
    assert.equal(settings.minimumBillableMinutes, 15);
    assert.equal(settings.billingIncrementMinutes, 5);
    assert.equal(settings.taxEnabled, false);
    assert.equal(settings.taxRateBasisPoints, 0);
    assert.equal(settings.noShowGraceMinutes, 15);
    assert.equal(settings.currency, "PKR");
    assert.equal(settings.backupEnabled, true);
    assert.equal(settings.backupIntervalHours, 12);
    assert.equal(settings.backupKeepCount, 30);
    assert.equal(settings.centuryPrice, 0);
    assert.equal(settings.framePrice, 0);
    assert.equal(settings.updatedBy, null);
  });

  await t.test("missing/null values: an unset rate is null raw, but resolves through the registry default (never a silent 0)", async () => {
    const settings = await settingsPg.getSettings();
    // Raw: nothing was ever set -> null, NOT 0 (0 would mean "explicitly switched off")
    assert.deepEqual(settings.gameRates, { century: null, frame: null, snooker_point: null, four_player: null });

    // describeSettings resolves them through config/gameModes.js's resolveGameRates - the SAME
    // shared function settings.service.js (MongoDB) uses - to the registry defaults:
    const described = settingsPg.describeSettings(settings);
    assert.deepEqual(described.gameRates, { century: 1000, frame: 25000, snooker_point: 35000, four_player: 50000 });
  });

  await t.test("creating/initializing again does NOT overwrite values already changed", async () => {
    await settingsPg.updateSettings({ noShowGraceMinutes: 45 });
    const settings = await settingsPg.getSettings(); // "create if missing" must never reset an existing row
    assert.equal(settings.noShowGraceMinutes, 45);
  });

  await t.test("updating: a game rate change is stored and precise, other fields untouched", async () => {
    // A REALISTIC actor for this step: logins are still 100% MongoDB (Users hasn't been ported -
    // that's Phase 3), so req.user._id is a Mongo ObjectId (24 hex chars), never a PostgreSQL
    // uuid. actorUserIdOrNull correctly recognises that and stores updated_by_user_id as null -
    // see "a real-looking but non-existent uuid is correctly refused" below for why that matters.
    const actor = { _id: "652f1c2e8a1b2c3d4e5f6071", name: "Admin Owner", username: "owner" };
    const updated = await settingsPg.updateSettings({ gameRates: { century: 1234 } }, actor);
    assert.equal(updated.gameRates.century, 1234);
    assert.equal(typeof updated.gameRates.century, "number");
    assert.equal(updated.gameRates.frame, null); // untouched - still "never set"
    assert.equal(updated.noShowGraceMinutes, 45); // the earlier change (previous test) survives
    assert.deepEqual(updated.updatedBy, { user: null, name: "Admin Owner", username: "owner" });

    // Re-reading from the database (not the in-memory return value) confirms it was really stored
    const reread = await settingsPg.getSettings();
    assert.equal(reread.gameRates.century, 1234);
  });

  await t.test("referential integrity: a uuid-SHAPED id that matches no real app.users row is correctly refused, not silently accepted", async () => {
    // This is exactly why updated_by_user_id cannot simply be "any uuid-looking string" today:
    // app.users has no real rows until Phase 3 ports Users, so the foreign key correctly blocks
    // even a syntactically valid uuid that names nobody - proof the constraint actually works,
    // not just that it exists (confirmed directly, not assumed).
    await assert.rejects(
      settingsPg.updateSettings({ gameRates: { century: 1 } }, { _id: "22222222-2222-2222-2222-222222222222", name: "Nobody", username: "nobody" }),
      /violates foreign key constraint "settings_updated_by_user_id_fkey"/
    );
  });

  await t.test("updating: a rate explicitly set to 0 means 'switched off', and must stay 0, not fall back to the default", async () => {
    const updated = await settingsPg.updateSettings({ gameRates: { frame: 0 } });
    assert.equal(updated.gameRates.frame, 0);
    const described = settingsPg.describeSettings(updated);
    assert.equal(described.gameRates.frame, 0, "0 must be respected, never replaced by the Rs 250 default");
  });

  await t.test("validation: framePrice and gameRates.frame disagreeing is refused (400), matching settings.service.js", async () => {
    await assert.rejects(
      settingsPg.updateSettings({ framePrice: 1, gameRates: { frame: 2 } }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /Send the Frame rate once/);
        return true;
      }
    );
    // ...and the matching-values case is accepted, keeping both fields in step (same rule)
    const updated = await settingsPg.updateSettings({ framePrice: 7777, gameRates: { frame: 7777 } });
    assert.equal(updated.framePrice, 7777);
    assert.equal(updated.gameRates.frame, 7777);
  });

  await t.test("monetary precision: MAX_PRICE round-trips exactly as a number, through a real update and re-read", async () => {
    const MAX_PRICE = 10_000_000;
    await settingsPg.updateSettings({ gameRates: { four_player: MAX_PRICE } });
    const reread = await settingsPg.getSettings();
    assert.equal(reread.gameRates.four_player, MAX_PRICE);
    assert.equal(typeof reread.gameRates.four_player, "number");
  });

  await t.test("concurrent initialization: many simultaneous reads never create a second row", async () => {
    await getPool().query("DELETE FROM app.settings"); // back to "never initialized" for this check
    const results = await Promise.all(Array.from({ length: 20 }, () => settingsPg.getSettings()));
    assert.ok(results.every((s) => s.key === "club"));
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.settings");
    assert.equal(count.rows[0].n, 1, "20 concurrent calls must still produce exactly one row");
  });

  await t.test("isolation: this pilot never touches MongoDB (no mongoose anywhere in its FULL require tree)", () => {
    // Walks every descendant, not just direct children - step 2.4's first version of this check
    // only looked at direct children, which happened to hide a real gap (settings.pg.service.js
    // then required models/schemas/actor.js, which itself requires "mongoose" - fixed in step
    // 2.5 by giving rowMappers.js its own small actorFrom instead; see docs/POSTGRES_MIGRATION.md).
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/settings.pg.service"));
    const mongooseFiles = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(mongooseFiles, [], "nothing in the full require tree lives under mongoose/ or server/models/");
  });
});
