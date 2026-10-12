// Tests for the Bills PostgreSQL pilot (Phase 2, step 2.6 - the schema's hardest model: ordered
// child rows AND the session/match partial-unique rules together - see
// docs/POSTGRES_MIGRATION.md). Needs PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED
// with a clear reason otherwise. Every MongoDB test, including the real bills.service.js ones,
// is completely unaffected.
//
// Scope reminder (see server/services/bills.pg.service.js's own header): this pilot is a
// repository only. It does not generate bill numbers (Counter.js), resolve café tabs, touch
// stock, or know Matches' business rules - those need their own, unported services. What it DOES
// use for real, unmodified, is billing.calculator.js's calculateBill() - a pure function with no
// MongoDB dependency - so the numbers this test saves are genuinely the same ones
// bills.service.js's own calculation would produce for the same inputs, not invented ones.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.6") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Bills pilot: ordered line items/players, partial-unique rules, FK, rollback, real billing maths", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const billsPg = require("../services/bills.pg.service");
  const { calculateBill, billableMinutes } = require("../services/billing.calculator"); // pure, no mongoose

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  // Minimal fixture only (see file header - no Sessions/Matches service exists): one table, two
  // sessions (so the "two sessions can each have a session-only bill" case has something real to
  // use), and one match (for the match-bill and Century-uniqueness cases).
  const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (701, 60000) RETURNING id");
  const tableId = table.rows[0].id;
  const makeSession = async (durationSeconds) => {
    const result = await getPool().query(
      "INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start, status, is_open, duration_seconds, ended_at) VALUES ($1, 701, 60000, 'completed', false, $2, now()) RETURNING id",
      [tableId, durationSeconds]
    );
    return result.rows[0].id;
  };
  const sessionAId = await makeSession(1800); // 30 real minutes played
  const sessionBId = await makeSession(3600);
  const match = await getPool().query(
    "INSERT INTO app.matches (session_id, number, table_id, table_number, game_mode, status) VALUES ($1, 1, $2, 701, 'century', 'completed') RETURNING id",
    [sessionBId, tableId]
  );
  const matchId = match.rows[0].id;

  // A real calculation, via the SAME pure function bills.service.js itself calls - Rs 10/min
  // (1000 paisa), 2 players, "split" (both pay), tax off. 30 minutes played -> billed exactly 30
  // (already a multiple of the 5-minute step, above the 15-minute minimum).
  const billedMinutes = billableMinutes(1800, 15, 5);
  const calc = calculateBill({
    gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", billedMinutes,
    taxEnabled: false, taxRateBasisPoints: 0, payerRule: "split",
    players: [{ name: "Ali", result: "loser" }, { name: "Usman", result: "winner" }],
  });

  function sessionOnlyBillData(sessionId, billNumber, calculation, billedMins) {
    return {
      billNumber, session: sessionId, table: tableId, tableNumber: 701, tableName: "",
      sessionStartedAt: new Date("2026-10-12T10:00:00Z"), sessionEndedAt: new Date("2026-10-12T10:30:00Z"),
      durationSeconds: 1800, billedMinutes: billedMins, gameMode: "century", quantity: 1, unitPrice: 1000,
      pricingType: "per_minute", payerRule: "split",
      subtotal: calculation.subtotal, taxEnabled: calculation.taxEnabled, taxRateBasisPoints: calculation.taxRateBasisPoints,
      taxAmount: calculation.taxAmount, total: calculation.total,
    };
  }

  let billAId;

  await t.test("1-2. create and retrieve: fields map correctly, real calculateBill() numbers preserved exactly", async () => {
    assert.equal(billedMinutes, 30);
    assert.equal(calc.subtotal, 30000); // 30 minutes x Rs 10/min = Rs 300.00 = 30000 paisa
    assert.equal(calc.total, 30000); // tax off

    const actor = { _id: "652f1c2e8a1b2c3d4e5f6071", name: "Admin Owner", username: "owner" };
    const bill = await billsPg.createBill(sessionOnlyBillData(sessionAId, "B-20261012-0001", calc, billedMinutes), calc.lineItems, calc.players, actor);
    billAId = bill.id;

    assert.match(billAId, /^[0-9a-f-]{36}$/);
    assert.equal(bill.billNumber, "B-20261012-0001");
    assert.equal(bill.session, sessionAId);
    assert.equal(bill.match, undefined); // a whole-session bill
    assert.equal(bill.gameMode, "century");
    assert.equal(bill.status, "unpaid");
    assert.equal(bill.amountPaid, 0);
    assert.equal(bill.balanceDue, 30000, "the generated column: total - amountPaid, cancelled aside");
    assert.deepEqual(bill.createdBy, { user: null, name: "Admin Owner", username: "owner" });

    const reread = await billsPg.getBillById(billAId);
    assert.deepEqual(reread, bill);
  });

  await t.test("3. multiple line items preserve their intended order (game line first, then café lines as given)", async () => {
    const sessionForThis = await makeSession(2400); // a fresh session - sessionA already has its one session-only bill
    const withCafe = calculateBill({
      gameMode: "frame", quantity: 2, unitPrice: 25000, pricingType: "per_frame",
      taxEnabled: false, taxRateBasisPoints: 0, payerRule: "loser",
      players: [{ name: "Solo", result: "loser" }],
      cafePayerRule: "split",
      cafeItems: [
        { description: "Cola", quantity: 2, unitPrice: 8000 },
        { description: "Chips", quantity: 1, unitPrice: 12000 },
        { description: "Water", quantity: 3, unitPrice: 5000 },
      ],
    });
    assert.equal(withCafe.lineItems.length, 4, "1 game line + 3 café lines");

    const bill = await billsPg.createBill(
      { ...sessionOnlyBillData(sessionForThis, "B-20261012-0002", withCafe, billedMinutes), gameMode: "frame", quantity: 2, unitPrice: 25000, pricingType: "per_frame", payerRule: "loser" },
      withCafe.lineItems, withCafe.players
    );
    assert.deepEqual(bill.lineItems.map((l) => l.description), ["Frames", "Cola", "Chips", "Water"]);
    const reread = await billsPg.getBillById(bill.id);
    assert.deepEqual(reread.lineItems.map((l) => l.description), ["Frames", "Cola", "Chips", "Water"], "order survives a re-read too");
  });

  await t.test("4. multiple players preserve their intended order", async () => {
    const sessionForThis = await makeSession(900); // a fresh session
    const fourPlayer = calculateBill({
      gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", billedMinutes: 15,
      taxEnabled: false, taxRateBasisPoints: 0, payerRule: "split",
      players: [{ name: "Dee" }, { name: "Charlie" }, { name: "Bilal" }, { name: "Alice" }],
    });
    const bill = await billsPg.createBill(
      sessionOnlyBillData(sessionForThis, "B-20261012-0003", fourPlayer, 15),
      fourPlayer.lineItems, fourPlayer.players
    );
    assert.deepEqual(bill.players.map((p) => p.name), ["Dee", "Charlie", "Bilal", "Alice"]);
    const reread = await billsPg.getBillById(bill.id);
    assert.deepEqual(reread.players.map((p) => p.name), ["Dee", "Charlie", "Bilal", "Alice"]);
  });

  await t.test("5. monetary precision, zero, null and missing values map correctly", async () => {
    const bill = await billsPg.getBillById(billAId);
    assert.equal(typeof bill.total, "number");
    assert.equal(bill.taxAmount, 0, "tax off -> 0, a real number, never a string");
    assert.equal(bill.cancelledAt, null);
    assert.equal(bill.pricingType, "per_minute");
    assert.equal(bill.match, undefined, "no match_id at all -> undefined (not null, not 0) once mapped");
    for (const player of bill.players) {
      assert.equal(player.gameShare, null, "never set on this calculation - null, not 0 or NaN");
      assert.equal(typeof player.shareAmount, "number");
    }
  });

  await t.test("6-7. foreign keys: a real session succeeds, an unknown or malformed one is refused", async () => {
    await assert.rejects(
      billsPg.createBill(sessionOnlyBillData("00000000-0000-0000-0000-000000000000", "B-20261012-0004", calc, billedMinutes), calc.lineItems, calc.players),
      /violates foreign key constraint/
    );
    await assert.rejects(
      billsPg.createBill(sessionOnlyBillData("not-a-uuid", "B-20261012-0005", calc, billedMinutes), calc.lineItems, calc.players)
    );
  });

  await t.test("8. duplicate session/match combinations are rejected per the partial-unique rules", async () => {
    // Session A already has a session-only bill (billAId) - a second one is refused
    await assert.rejects(
      billsPg.createBill(sessionOnlyBillData(sessionAId, "B-20261012-0006", calc, billedMinutes), calc.lineItems, calc.players),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "This session already has a bill"); return true; }
    );
    // A duplicate bill_number (even for a different, otherwise-valid session) is refused too
    await assert.rejects(
      billsPg.createBill(sessionOnlyBillData(sessionBId, "B-20261012-0001", calc, billedMinutes), calc.lineItems, calc.players),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "A bill with this number already exists"); return true; }
    );

    // A match bill for matchId (session B) - first one succeeds
    const matchData = { ...sessionOnlyBillData(sessionBId, "B-20261012-0007", calc, billedMinutes), match: matchId, matchNumber: 1 };
    await billsPg.createBill(matchData, calc.lineItems, calc.players);
    // The SAME match billed again is refused (bills_one_per_session_and_match)
    await assert.rejects(
      billsPg.createBill({ ...matchData, billNumber: "B-20261012-0008" }, calc.lineItems, calc.players),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "This match already has a bill"); return true; }
    );
    // A second Century (per_minute) match bill for the SAME session is refused too
    // (bills_one_century_per_session) - session B already has one via the match bill above.
    const anotherMatch = await getPool().query(
      "INSERT INTO app.matches (session_id, number, table_id, table_number, game_mode, status) VALUES ($1, 2, $2, 701, 'century', 'completed') RETURNING id",
      [sessionBId, tableId]
    );
    await assert.rejects(
      billsPg.createBill(
        { ...sessionOnlyBillData(sessionBId, "B-20261012-0009", calc, billedMinutes), match: anotherMatch.rows[0].id, matchNumber: 2 },
        calc.lineItems, calc.players
      ),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /can have only one Century bill/); return true; }
    );
  });

  await t.test("9. permitted nullable session/match combinations: a DIFFERENT session's session-only bill is fine", async () => {
    // Session B already has a match bill; it is still free to ALSO get bills for its other
    // matches (tested above) - what this check confirms is that session-only (match=null)
    // uniqueness is scoped PER SESSION, not global: a different session entirely is unaffected
    // by session A already having one.
    const sessionC = await makeSession(2700);
    const bill = await billsPg.createBill(sessionOnlyBillData(sessionC, "B-20261012-0010", calc, billedMinutes), calc.lineItems, calc.players);
    assert.equal(bill.session, sessionC);
  });

  await t.test("10. transaction rollback: a failing player insert undoes the bill AND its line items too", async () => {
    const sessionD = await makeSession(900);
    const before = await getPool().query("SELECT count(*)::int AS n FROM app.bills");
    await assert.rejects(
      billsPg.createBill(
        sessionOnlyBillData(sessionD, "B-20261012-0011", calc, billedMinutes),
        calc.lineItems,
        [{ name: "Broken", result: "not-a-real-result", shareAmount: 1000 }] // violates bill_players' result CHECK constraint
      )
    );
    const after = await getPool().query("SELECT count(*)::int AS n FROM app.bills");
    assert.equal(after.rows[0].n, before.rows[0].n, "the bill row from the same transaction must not have survived");
    const orphanLineItems = await getPool().query("SELECT count(*)::int AS n FROM app.bill_line_items WHERE bill_id NOT IN (SELECT id FROM app.bills)");
    assert.equal(orphanLineItems.rows[0].n, 0, "no orphaned line items either - the whole transaction rolled back together");
  });

  await t.test("isolation: the Bills pilot service never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/bills.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
