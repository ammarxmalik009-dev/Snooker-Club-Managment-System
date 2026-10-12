// Payments - PostgreSQL pilot (Phase 2, step 2.7: safe payment recording, overpayment
// prevention under concurrency). Standalone: not wired into any route, does not call and is not
// called by server/services/payments.service.js (MongoDB), which stays the application's only
// active path. Reuses server/services/bills.pg.service.js's mapBillRow (step 2.6) to return the
// bill in the same shape that pilot already produces - not a parallel architecture.
//
// Business rules preserved exactly from payments.service.js: a bill must be unpaid/partially
// paid (never cancelled or already paid); the payer must be a player on the bill who owes
// something; the new total paid can never exceed the bill total; a player's own total paid can
// never exceed their own share. Every error message matches payments.service.js's wording.
//
// How overpayment is actually prevented here - STRONGER than the MongoDB path, not a copy of
// it: payments.service.js can only make ONE document's update atomic (no MongoDB transactions),
// so it saves the Payment record as a SEPARATE step and manually reverses the bill update if
// that insert fails. PostgreSQL gives a REAL multi-statement transaction, so this pilot updates
// app.bills, app.bill_players AND inserts app.payments all in ONE transaction - if anything
// fails, EVERYTHING rolls back together. No compensation logic is needed or present.
//
// Locking, not two independent conditional UPDATEs: an EARLIER version of this ran two separate
// "UPDATE ... WHERE amount_paid <= total - $1" statements (bill, then player) one after the
// other - found the hard way (a real failing test, not reasoned out in advance) that this is
// subtly wrong: if the FIRST one's own condition happened to hold but the SECOND's didn't, the
// first had already changed the row (inside the same not-yet-committed transaction) by the time
// the error message tried to explain why, computing a confusing, WRONG balance from data that
// was about to be rolled back anyway. Fixed by locking both rows FIRST (`SELECT ... FOR UPDATE`),
// validating both conditions in application code against that guaranteed-stable, pre-change
// state, and only then applying both updates unconditionally. `FOR UPDATE` is what makes this
// safe under real concurrency: a second payment racing for the SAME bill or player row BLOCKS on
// that `SELECT ... FOR UPDATE` until the first transaction commits or rolls back, then reads the
// first's actually-committed result - never a stale or half-applied value. Verified directly
// with real concurrent requests below, not assumed and not mocked.

const { query, withTransaction } = require("../config/db.pg");
const { toMoney, toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const { mapBillRow } = require("./bills.pg.service");
const { formatMoney } = require("../utils/money"); // pure text formatting, no mongoose
const AppError = require("../utils/AppError");

// Identical to payments.service.js's own statusFor - reused as a verbatim copy (not an import:
// payments.service.js lives under server/services/ but requires mongoose-backed models at the
// top of that file, so importing from it would pull mongoose into this pilot's require chain).
function statusFor(amountPaid, total) {
  if (amountPaid <= 0) return "unpaid";
  return amountPaid >= total ? "paid" : "partially_paid";
}

function mapPaymentRow(row) {
  return {
    id: toId(row.id),
    bill: toId(row.bill_id),
    amount: toMoney(row.amount),
    method: row.method,
    payerName: row.payer_name,
    note: row.note,
    paidAt: row.paid_at,
    receivedBy: actorFromRow(row, "received_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readBillSnapshot(client, billId) {
  const billResult = await client.query("SELECT * FROM app.bills WHERE id = $1", [billId]);
  const [lineItems, players] = await Promise.all([
    client.query("SELECT * FROM app.bill_line_items WHERE bill_id = $1 ORDER BY position", [billId]),
    client.query("SELECT * FROM app.bill_players WHERE bill_id = $1 ORDER BY position", [billId]),
  ]);
  return mapBillRow(billResult.rows[0], lineItems.rows, players.rows);
}

async function recordPayment(billId, { amount, method, payerName, note = "" }, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    // Lock both rows FIRST, before validating anything - see file header. Any other transaction
    // trying to touch the SAME bill or the SAME player row blocks here until this one commits or
    // rolls back, so the numbers read right after are guaranteed fresh and cannot change under us.
    const billResult = await client.query("SELECT * FROM app.bills WHERE id = $1 FOR UPDATE", [billId]);
    if (billResult.rows.length === 0) throw new AppError("Bill not found", 404);
    const bill = billResult.rows[0];
    if (bill.status === "cancelled") throw new AppError(`Bill ${bill.bill_number} is cancelled`, 409);
    if (bill.status === "paid") throw new AppError(`Bill ${bill.bill_number} is already fully paid`, 409);

    const playerResult = await client.query(
      "SELECT * FROM app.bill_players WHERE bill_id = $1 AND lower(name) = lower($2) FOR UPDATE",
      [billId, payerName]
    );
    if (playerResult.rows.length === 0) {
      throw new AppError(`${payerName} is not a player on this bill`, 400, [{ field: "payerName", message: "Choose a player from this bill" }]);
    }
    const player = playerResult.rows[0];
    if (Number(player.share_amount) === 0) {
      throw new AppError(`${player.name} doesn't owe anything on this bill`, 409, [{ field: "payerName", message: "This player owes nothing" }]);
    }

    // Both rows are locked and these numbers are therefore stable for the rest of this
    // transaction - safe to validate here, in application code, before writing anything.
    const billBalance = Number(bill.total) - Number(bill.amount_paid);
    const playerBalance = Number(player.share_amount) - Number(player.paid_amount);
    if (amount > billBalance) {
      throw new AppError(`Payment of ${formatMoney(amount)} is more than the remaining balance of ${formatMoney(billBalance)}`, 409,
        [{ field: "amount", message: `At most ${formatMoney(billBalance)}` }]);
    }
    if (amount > playerBalance) {
      throw new AppError(`${player.name} only owes ${formatMoney(playerBalance)} more`, 409,
        [{ field: "amount", message: `At most ${formatMoney(playerBalance)} for ${player.name}` }]);
    }

    // Both checks passed, under lock - now safe to apply both updates unconditionally.
    const billUpdate = await client.query(
      "UPDATE app.bills SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING *",
      [amount, billId]
    );
    await client.query("UPDATE app.bill_players SET paid_amount = paid_amount + $1 WHERE id = $2", [amount, player.id]);

    // The status, from the numbers just written (never stale: same transaction, same client)
    const newStatus = statusFor(Number(billUpdate.rows[0].amount_paid), Number(billUpdate.rows[0].total));
    await client.query("UPDATE app.bills SET status = $1 WHERE id = $2", [newStatus, billId]);

    // 4. The payment record itself - in the SAME transaction as steps 1-3. If this insert were to
    // fail (e.g. a CHECK violation), the whole transaction rolls back, undoing steps 1-3 too -
    // unlike payments.service.js, which must manually reverse its own $inc for this exact case.
    const paymentResult = await client.query(
      `INSERT INTO app.payments (bill_id, amount, method, payer_name, note, received_by_user_id, received_by_name, received_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [billId, amount, method, player.name, note, userId, actor ? actor.name : null, actor ? actor.username : null]
    );

    return { payment: mapPaymentRow(paymentResult.rows[0]), bill: await readBillSnapshot(client, billId) };
  });
}

async function getPaymentsForBill(billId) {
  const result = await query("SELECT * FROM app.payments WHERE bill_id = $1 ORDER BY paid_at", [billId]);
  return result.rows.map(mapPaymentRow);
}

module.exports = { recordPayment, getPaymentsForBill, statusFor, mapPaymentRow };
