// Tests for the Users and AuthSession PostgreSQL pilots (Phase 2, step 2.8 - see
// docs/POSTGRES_MIGRATION.md). Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED
// with a clear reason otherwise. Every MongoDB test, including the real users.service.js and
// auth.service.js ones, is completely unaffected - login, logout and the auth middleware are
// never touched by anything in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.8") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Users + AuthSession pilots: creation, uniqueness, last-admin protection, real foreign keys", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const usersPg = require("../services/users.pg.service");
  const authSessionsPg = require("../services/authSessions.pg.service");
  const { verifyPassword } = require("../utils/password"); // pure Node crypto, no mongoose

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  const STRONG_PASSWORD = "Snooker-cue-2026";
  let admin1;

  await t.test("1. creating and retrieving a user, by id and by username - never the password hash", async () => {
    admin1 = await usersPg.createUser({ name: "Admin One", username: "Admin.One", role: "admin", password: STRONG_PASSWORD });
    assert.match(admin1.id, /^[0-9a-f-]{36}$/);
    assert.equal(admin1.username, "admin.one", "normalized: trimmed and lower-cased, same rule as models/User.js");
    assert.equal(admin1.active, true);
    assert.equal(admin1.role, "admin");
    assert.equal("passwordHash" in admin1, false, "never present on the object the service returns");
    assert.equal("password_hash" in admin1, false);

    const byId = await usersPg.getUserById(admin1.id);
    assert.deepEqual(byId, admin1);
    const byUsername = await usersPg.getUserByUsername("  ADMIN.ONE  "); // same normalization as login
    assert.deepEqual(byUsername, admin1);
  });

  await t.test("2. password hash: stored using the project's real scrypt implementation, verifiable, never exposed", async () => {
    // Reads the RAW row directly - bypassing the service's own mapper entirely - purely to prove
    // what is actually sitting in the column, which the service itself never returns to anyone.
    const raw = await getPool().query("SELECT password_hash FROM app.users WHERE id = $1", [admin1.id]);
    const stored = raw.rows[0].password_hash;
    assert.match(stored, /^scrypt\$16384\$8\$1\$/, "the exact format/cost server/utils/password.js writes - not a new algorithm, not plaintext");
    assert.ok(await verifyPassword(STRONG_PASSWORD, stored), "the real, unmodified verifyPassword() must accept the password that was just set");
    assert.ok(!(await verifyPassword("Wrong-password-9", stored)), "and reject a wrong one");

    // Sanity: the column really exists on the table (so "never returned" above is meaningful,
    // not just a column that was never there to leak in the first place).
    const columnExists = await getPool().query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'users' AND column_name = 'password_hash'"
    );
    assert.equal(columnExists.rowCount, 1);
  });

  await t.test("3. unique username: a duplicate (case/space-insensitive) is refused, the original is untouched", async () => {
    await assert.rejects(
      usersPg.createUser({ name: "Impostor", username: "  admin.one  ", role: "staff", password: STRONG_PASSWORD }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already taken/); return true; }
    );
    const stillThere = await usersPg.getUserById(admin1.id);
    assert.equal(stillThere.name, "Admin One", "the original row was not corrupted by the failed duplicate attempt");
    const count = await getPool().query("SELECT count(*)::int AS n FROM app.users WHERE username = 'admin.one'");
    assert.equal(count.rows[0].n, 1, "exactly one row with this username, never two");
  });

  await t.test("4. invalid ids, missing users, and invalid role values are all refused cleanly", async () => {
    await assert.rejects(
      usersPg.getUserById("00000000-0000-0000-0000-000000000000"),
      (error) => { assert.equal(error.statusCode, 404); assert.equal(error.message, "User not found"); return true; }
    );
    await assert.rejects(usersPg.getUserById("not-a-uuid"));
    await assert.rejects(
      usersPg.createUser({ name: "Bad Role", username: "badrole", role: "owner", password: STRONG_PASSWORD }),
      (error) => { assert.equal(error.statusCode, 400); assert.match(error.message, /Role must be one of/); return true; }
    );
    await assert.rejects(
      usersPg.createUser({ name: "Weak", username: "weakpass", role: "staff", password: "short" }),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
  });

  let admin2;
  await t.test("5. foreign key, using a REAL user row: admin1 creates admin2 - created_by_user_id actually resolves, not null", async () => {
    const actor = { _id: admin1.id, name: admin1.name, username: admin1.username };
    admin2 = await usersPg.createUser({ name: "Admin Two", username: "admin.two", role: "admin", password: STRONG_PASSWORD }, actor);
    assert.deepEqual(admin2.createdBy, { user: admin1.id, name: "Admin One", username: "admin.one" });
    assert.deepEqual(admin2.updatedBy, { user: admin1.id, name: "Admin One", username: "admin.one" });

    const fk = await getPool().query(
      "SELECT u2.created_by_user_id = u1.id AS matches FROM app.users u1, app.users u2 WHERE u1.id = $1 AND u2.id = $2",
      [admin1.id, admin2.id]
    );
    assert.equal(fk.rows[0].matches, true, "the foreign key genuinely points at admin1's real row, confirmed by a join");
  });

  await t.test("6. updating permitted fields works normally with two active admins", async () => {
    const actor = { _id: admin1.id, name: admin1.name, username: admin1.username };
    const demoted = await usersPg.updateUser(admin2.id, { role: "staff" }, actor);
    assert.equal(demoted.role, "staff");
    assert.deepEqual(demoted.updatedBy, { user: admin1.id, name: "Admin One", username: "admin.one" });
  });

  await t.test("7. self-protection: can't deactivate your own account, can't remove your own admin role", async () => {
    const selfActor = { _id: admin1.id, name: admin1.name, username: admin1.username };
    await assert.rejects(
      usersPg.updateUser(admin1.id, { active: false }, selfActor),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can't deactivate your own account/); return true; }
    );
    await assert.rejects(
      usersPg.updateUser(admin1.id, { role: "staff" }, selfActor),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can't remove your own admin role/); return true; }
    );
  });

  await t.test("8. transaction rollback: the last active admin cannot be demoted - nothing is left half-applied", async () => {
    // admin2 is now staff (test 6) - admin1 is the ONLY active admin. A different actor (admin2,
    // now staff) tries to demote admin1: the self-checks don't apply (not self), so this reaches
    // the last-admin count check, which must reject it and roll back completely.
    const otherActor = { _id: admin2.id, name: "Admin Two", username: "admin.two" };
    await assert.rejects(
      usersPg.updateUser(admin1.id, { role: "staff" }, otherActor),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /last active admin/); return true; }
    );
    const stillAdmin = await usersPg.getUserById(admin1.id);
    assert.equal(stillAdmin.role, "admin", "the attempted role change must not have been applied");
    assert.equal(stillAdmin.updatedBy, null, "admin1 was never actually updated by anyone (created with no actor) - the rolled-back attempt must not have changed that either");
  });

  await t.test("9. AuthSession: create, read by token hash, foreign key to a real user, revoke", async () => {
    const tokenHash = "a".repeat(64); // a plausible HMAC-SHA256 hex digest shape, not a real secret
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const session = await authSessionsPg.createSession({ userId: admin1.id, tokenHash, expiresAt, userAgent: "test-agent", ip: "127.0.0.1" });
    assert.equal(session.user, admin1.id);
    assert.equal(session.tokenHash, tokenHash);

    const reread = await authSessionsPg.getSessionByTokenHash(tokenHash);
    assert.deepEqual(reread, session);

    const revoked = await authSessionsPg.revokeSession(session.id);
    assert.equal(revoked.id, session.id);
    assert.equal(await authSessionsPg.getSessionByTokenHash(tokenHash), null, "gone after revoking");
  });

  await t.test("10. AuthSession: the user_id foreign key is NOT NULL and rejects a non-existent user", async () => {
    await assert.rejects(
      authSessionsPg.createSession({ userId: "00000000-0000-0000-0000-000000000000", tokenHash: "b".repeat(64), expiresAt: new Date() }),
      (error) => { assert.equal(error.statusCode, 400); assert.equal(error.message, "User does not exist"); return true; }
    );
    await assert.rejects(authSessionsPg.createSession({ userId: null, tokenHash: "c".repeat(64), expiresAt: new Date() }));
  });

  await t.test("11. closes step 2.7's gap: a payment's received_by_user_id now resolves to a REAL user, not null", async () => {
    const billsPg = require("../services/bills.pg.service");
    const paymentsPg = require("../services/payments.pg.service");
    const { calculateBill } = require("../services/billing.calculator");

    const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (901, 60000) RETURNING id");
    const session = await getPool().query(
      "INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start, status, is_open, duration_seconds, ended_at) VALUES ($1, 901, 60000, 'completed', false, 1800, now()) RETURNING id",
      [table.rows[0].id]
    );
    const calc = calculateBill({
      gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", billedMinutes: 30,
      taxEnabled: false, taxRateBasisPoints: 0, payerRule: "split", players: [{ name: "Ali" }, { name: "Usman" }],
    });
    const bill = await billsPg.createBill(
      { billNumber: "B-20261012-U001", session: session.rows[0].id, table: table.rows[0].id, tableNumber: 901, tableName: "",
        sessionStartedAt: new Date(), sessionEndedAt: new Date(), durationSeconds: 1800, billedMinutes: 30,
        gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", payerRule: "split", ...calc },
      calc.lineItems, calc.players
    );

    // admin1.id is now a REAL app.users row - unlike every step 2.7 test, which only ever had
    // actor ids shaped like MongoDB ObjectIds (always mapped to null, correctly, since nothing
    // real existed to point at).
    const realActor = { _id: admin1.id, name: admin1.name, username: admin1.username };
    const { payment } = await paymentsPg.recordPayment(bill.id, { amount: 5000, method: "cash", payerName: "Ali" }, realActor);
    assert.equal(payment.receivedBy.user, admin1.id, "received_by_user_id must now be the REAL user id, not null");

    const fk = await getPool().query(
      "SELECT p.received_by_user_id = u.id AS matches FROM app.payments p, app.users u WHERE p.id = $1 AND u.id = $2",
      [payment.id, admin1.id]
    );
    assert.equal(fk.rows[0].matches, true, "confirmed by a join - the foreign key genuinely resolves");

    // And a non-existent user id is still correctly rejected by the same foreign key (unchanged
    // behaviour from step 2.7 - this pilot only adds the ability to point at something real).
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 1, method: "cash", payerName: "Usman" },
        { _id: "22222222-2222-2222-2222-222222222222", name: "Nobody", username: "nobody" }),
      /violates foreign key constraint "payments_received_by_user_id_fkey"/
    );
  });

  await t.test("isolation: neither pilot touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    for (const entry of ["../services/users.pg.service", "../services/authSessions.pg.service"]) {
      const ids = transitiveChildren(require.resolve(entry));
      const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
      assert.deepEqual(forbidden, [], entry);
    }
  });
});
