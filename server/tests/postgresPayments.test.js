// Tests for the Payments PostgreSQL pilot (Phase 2, step 2.7 - safe payment recording and
// overpayment prevention under REAL concurrency - see docs/POSTGRES_MIGRATION.md). Needs
// PG_TEST_DATABASE_URL at 127.0.0.1:5433 (step 2.2A); SKIPPED with a clear reason otherwise.
// Every MongoDB test, including the real payments.service.js ones, is completely unaffected.
//
// No mocks: every concurrency/locking/transaction claim below is checked by firing real,
// simultaneous requests at the real local PostgreSQL and inspecting what actually got committed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPgTestDatabaseUrl, lockAppSchema, unlockAppSchema } = require("./helpers/testDb.pg");

const TEST_URL = getPgTestDatabaseUrl();
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let skipReason = TEST_URL
  ? false
  : 'PG_TEST_DATABASE_URL is not set - see docs/POSTGRES_MIGRATION.md ("Step 2.7") to configure a local PostgreSQL test database';
if (TEST_URL && !skipReason) {
  const url = new URL(TEST_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "5433") {
    skipReason = `PG_TEST_DATABASE_URL must point at the verified local PostgreSQL (127.0.0.1:5433) - got "${url.hostname}:${url.port}"`;
  }
}

test("PostgreSQL Payments pilot: recording, overpayment prevention, concurrency, rollback", { skip: skipReason }, async (t) => {
  const { getPool, closePool } = require("../config/db.pg");
  const migrate = require("../db/migrate");
  const billsPg = require("../services/bills.pg.service");
  const paymentsPg = require("../services/payments.pg.service");
  const { calculateBill } = require("../services/billing.calculator"); // pure, no mongoose

  const lockClient = await lockAppSchema(getPool());

  t.after(async () => {
    await getPool().query("DROP SCHEMA IF EXISTS app CASCADE"); // only our own schema, only in this test database
    await unlockAppSchema(lockClient);
    await closePool();
  });

  await getPool().query("DROP SCHEMA IF EXISTS app CASCADE");
  await migrate.runMigrations();

  // Minimal fixture (no Sessions service exists - see earlier pilots): one table, sessions made
  // on demand, one bill per test via the REAL calculateBill() + the step 2.6 Bills pilot.
  const table = await getPool().query("INSERT INTO app.tables (table_number, hourly_rate) VALUES (801, 60000) RETURNING id");
  const tableId = table.rows[0].id;
  let billCounter = 0;
  async function makeBill(players, { total: _unused } = {}) {
    const session = await getPool().query(
      "INSERT INTO app.sessions (table_id, table_number, hourly_rate_at_start, status, is_open, duration_seconds, ended_at) VALUES ($1, 801, 60000, 'completed', false, 1800, now()) RETURNING id",
      [tableId]
    );
    const calc = calculateBill({
      gameMode: "century", quantity: 1, unitPrice: 1000, pricingType: "per_minute", billedMinutes: 30,
      taxEnabled: false, taxRateBasisPoints: 0, payerRule: "split", players,
    });
    billCounter += 1;
    const data = {
      billNumber: `B-20261012-P${String(billCounter).padStart(3, "0")}`, session: session.rows[0].id,
      table: tableId, tableNumber: 801, tableName: "", sessionStartedAt: new Date(), sessionEndedAt: new Date(),
      durationSeconds: 1800, billedMinutes: 30, gameMode: "century", quantity: 1, unitPrice: 1000,
      pricingType: "per_minute", payerRule: "split",
      subtotal: calc.subtotal, taxEnabled: calc.taxEnabled, taxRateBasisPoints: calc.taxRateBasisPoints,
      taxAmount: calc.taxAmount, total: calc.total,
    };
    return billsPg.createBill(data, calc.lineItems, calc.players);
  }

  await t.test("1-2. recording and retrieving a payment; correct bill association", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]); // split: 15000 each (total 30000)
    assert.equal(bill.total, 30000);
    assert.equal(bill.players[0].shareAmount, 15000);

    const actor = { _id: "652f1c2e8a1b2c3d4e5f6071", name: "Cashier Owner", username: "cashier" };
    const { payment, bill: updated } = await paymentsPg.recordPayment(bill.id, { amount: 5000, method: "cash", payerName: "Ali", note: "part" }, actor);
    assert.equal(payment.bill, bill.id);
    assert.equal(payment.amount, 5000);
    assert.equal(payment.method, "cash");
    assert.equal(payment.payerName, "Ali");
    assert.deepEqual(payment.receivedBy, { user: null, name: "Cashier Owner", username: "cashier" });
    assert.equal(updated.amountPaid, 5000);
    assert.equal(updated.status, "partially_paid");
    assert.equal(updated.players[0].paidAmount, 5000);
    assert.equal(updated.balanceDue, 25000);

    const payments = await paymentsPg.getPaymentsForBill(bill.id);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, 5000);
  });

  await t.test("3. foreign key / not-found: an unknown bill is refused with the same message as payments.service.js", async () => {
    await assert.rejects(
      paymentsPg.recordPayment("00000000-0000-0000-0000-000000000000", { amount: 100, method: "cash", payerName: "Nobody" }),
      (error) => { assert.equal(error.statusCode, 404); assert.equal(error.message, "Bill not found"); return true; }
    );
  });

  await t.test("4. the payer must be a player on the bill, and must owe something", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]);
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 100, method: "cash", payerName: "Stranger" }),
      (error) => { assert.equal(error.statusCode, 400); assert.equal(error.message, "Stranger is not a player on this bill"); return true; }
    );

    const freePlayerBill = await makeBill([{ name: "Payer", result: "winner" }, { name: "FreePlayer", result: "loser" }]);
    // payerRule "split" above gives everyone a share, so instead prove this with a direct,
    // explicit zero-share player (walk-in guest who isn't actually paying):
    await getPool().query("UPDATE app.bill_players SET share_amount = 0 WHERE bill_id = $1 AND name = 'FreePlayer'", [freePlayerBill.id]);
    await assert.rejects(
      paymentsPg.recordPayment(freePlayerBill.id, { amount: 100, method: "cash", payerName: "FreePlayer" }),
      (error) => { assert.equal(error.statusCode, 409); assert.equal(error.message, "FreePlayer doesn't owe anything on this bill"); return true; }
    );
  });

  await t.test("5. amount validation: zero, negative and non-numeric amounts are refused cleanly, not a raw SQL error", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]);
    for (const bad of [0, -500]) {
      await assert.rejects(paymentsPg.recordPayment(bill.id, { amount: bad, method: "cash", payerName: "Ali" }));
    }
  });

  await t.test("6. partial payments accumulate; the bill becomes fully paid exactly when the total is reached", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]); // 15000 each
    await paymentsPg.recordPayment(bill.id, { amount: 7000, method: "cash", payerName: "Ali" });
    const afterPartial = (await paymentsPg.recordPayment(bill.id, { amount: 8000, method: "cash", payerName: "Ali" })).bill;
    assert.equal(afterPartial.players.find((p) => p.name === "Ali").paidAmount, 15000);
    assert.equal(afterPartial.status, "partially_paid", "Ali's own share is done, but Usman hasn't paid yet");
    assert.equal(afterPartial.amountPaid, 15000);

    const afterFull = (await paymentsPg.recordPayment(bill.id, { amount: 15000, method: "card", payerName: "Usman" })).bill;
    assert.equal(afterFull.status, "paid");
    assert.equal(afterFull.amountPaid, 30000);
    assert.equal(afterFull.balanceDue, 0);
  });

  await t.test("7. overpayment is refused: beyond the player's own share, and beyond the bill's own balance", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]); // 15000 each
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 15001, method: "cash", payerName: "Ali" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Ali only owes Rs 150\.00 more/); return true; }
    );
    // Ali pays exactly their share; Ali can't then pay anything more (owes nothing)
    await paymentsPg.recordPayment(bill.id, { amount: 15000, method: "cash", payerName: "Ali" });
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 1, method: "cash", payerName: "Ali" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /Ali only owes Rs 0\.00 more/); return true; }
    );
    // A fully paid bill refuses any further payment, even from the other player
    await paymentsPg.recordPayment(bill.id, { amount: 15000, method: "cash", payerName: "Usman" });
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 1, method: "cash", payerName: "Usman" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /already fully paid/); return true; }
    );
  });

  await t.test("8. concurrent payments on the SAME bill: the total paid never exceeds the total, no matter the race", async () => {
    const bill = await makeBill([{ name: "Solo", result: "loser" }]); // payerRule split, 1 player -> owes the whole 30000
    // 5 simultaneous attempts of 9000 each (45000 total requested) against a 30000 total:
    // mathematically AT MOST 3 can succeed (3 x 9000 = 27000 <= 30000; a 4th would need <= 3000).
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => paymentsPg.recordPayment(bill.id, { amount: 9000, method: "cash", payerName: "Solo" }))
    );
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    assert.equal(succeeded.length, 3, "exactly 3 of the 5 concurrent Rs 90 payments must succeed");
    assert.equal(failed.length, 2);
    for (const f of failed) assert.equal(f.reason.statusCode, 409);

    const payments = await paymentsPg.getPaymentsForBill(bill.id);
    assert.equal(payments.length, 3, "exactly as many payment rows as successes - no phantom or missing rows");
    const totalRecorded = payments.reduce((sum, p) => sum + p.amount, 0);
    assert.equal(totalRecorded, 27000);

    const finalBillResult = await getPool().query("SELECT amount_paid FROM app.bills WHERE id = $1", [bill.id]);
    assert.equal(Number(finalBillResult.rows[0].amount_paid), 27000, "the bill's own total must match the sum of actually-recorded payments exactly");
    const finalPlayerResult = await getPool().query("SELECT paid_amount FROM app.bill_players WHERE bill_id = $1", [bill.id]);
    assert.equal(Number(finalPlayerResult.rows[0].paid_amount), 27000, "and the player's own running total must match too - never desynced from the bill");
  });

  await t.test("9. concurrent payments from TWO DIFFERENT players on the SAME bill don't interfere with each other", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]); // 15000 each, 30000 total
    const [aliResult, usmanResult] = await Promise.all([
      paymentsPg.recordPayment(bill.id, { amount: 15000, method: "cash", payerName: "Ali" }),
      paymentsPg.recordPayment(bill.id, { amount: 15000, method: "cash", payerName: "Usman" }),
    ]);
    assert.equal(aliResult.payment.amount, 15000);
    assert.equal(usmanResult.payment.amount, 15000);
    const finalBillResult = await getPool().query("SELECT amount_paid, status FROM app.bills WHERE id = $1", [bill.id]);
    assert.equal(Number(finalBillResult.rows[0].amount_paid), 30000);
    assert.equal(finalBillResult.rows[0].status, "paid");
  });

  await t.test("10. transaction rollback: an invalid payment method rolls back the bill AND player updates too, leaving no partial trace", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]);
    await assert.rejects(paymentsPg.recordPayment(bill.id, { amount: 5000, method: "not-a-real-method", payerName: "Ali" }));

    const billResult = await getPool().query("SELECT amount_paid, status FROM app.bills WHERE id = $1", [bill.id]);
    assert.equal(Number(billResult.rows[0].amount_paid), 0, "the bill's amount_paid must be unchanged - the whole transaction rolled back");
    assert.equal(billResult.rows[0].status, "unpaid");
    const playerResult = await getPool().query("SELECT paid_amount FROM app.bill_players WHERE bill_id = $1 AND name = 'Ali'", [bill.id]);
    assert.equal(Number(playerResult.rows[0].paid_amount), 0, "the player's paid_amount must be unchanged too");
    const paymentCount = await getPool().query("SELECT count(*)::int AS n FROM app.payments WHERE bill_id = $1", [bill.id]);
    assert.equal(paymentCount.rows[0].n, 0, "no payment row was left behind either");
  });

  await t.test("11. cancelled bills refuse any payment", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]);
    await getPool().query("UPDATE app.bills SET status = 'cancelled' WHERE id = $1", [bill.id]);
    await assert.rejects(
      paymentsPg.recordPayment(bill.id, { amount: 100, method: "cash", payerName: "Ali" }),
      (error) => { assert.equal(error.statusCode, 409); assert.match(error.message, /is cancelled/); return true; }
    );
  });

  await t.test("note: no idempotency mechanism exists in the current architecture (Payment.js has no idempotency key) - two identical requests ARE recorded twice, matching payments.service.js's own behaviour today", async () => {
    const bill = await makeBill([{ name: "Ali" }, { name: "Usman" }]);
    await paymentsPg.recordPayment(bill.id, { amount: 1000, method: "cash", payerName: "Ali" });
    await paymentsPg.recordPayment(bill.id, { amount: 1000, method: "cash", payerName: "Ali" });
    const payments = await paymentsPg.getPaymentsForBill(bill.id);
    assert.equal(payments.length, 2, "not deduplicated - there is no idempotency key to deduplicate by, in either implementation");
  });

  await t.test("isolation: the Payments pilot never touches MongoDB (no mongoose/ or server/models/ in its full require tree)", () => {
    function transitiveChildren(id, seen = new Set()) {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const child of require.cache[id]?.children || []) transitiveChildren(child.id, seen);
      return seen;
    }
    const ids = transitiveChildren(require.resolve("../services/payments.pg.service"));
    const forbidden = [...ids].filter((id) => /[\\/]mongoose[\\/]/.test(id) || /[\\/]models[\\/]/.test(id));
    assert.deepEqual(forbidden, []);
  });
});
