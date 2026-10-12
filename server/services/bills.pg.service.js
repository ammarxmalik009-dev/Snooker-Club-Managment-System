// Bills - PostgreSQL pilot (Phase 2, step 2.6: ordered child rows AND partial-unique rules on
// the schema's most complex model). Standalone: not wired into any route, does not call and is
// not called by server/services/bills.service.js (MongoDB), which stays the application's only
// active path.
//
// SCOPED NARROWLY ON PURPOSE - this is a REPOSITORY, not a port of bills.service.js's business
// logic. It takes an ALREADY-CALCULATED bill (the same shape bills.service.js's prepareBill()
// produces: every number worked out, every snapshot copied) and only handles saving/reading it
// through this schema. It does NOT:
//   - run billing.calculator.js's maths (time rule, splits, tax) - callers must supply the final numbers;
//   - generate the bill number (Counter.js / nextSequence - not ported; callers supply one);
//   - resolve café tabs, claim stock, or touch cafe_orders/stock_movements/products history;
//   - know anything about Matches' own business rules (loadBillableMatch, anotherBillableMatch).
// Those all belong to Sessions/Matches/Payments/Café pilots of their own (see docs/POSTGRES_MIGRATION.md).
// Porting bills.service.js for real needs ALL of those first - attempting it here would mean
// re-implementing them badly just to "make a pilot work", which is exactly what was avoided.

const { query, withTransaction } = require("../config/db.pg");
const { toMoney, toId, actorFromRow, actorFrom, actorUserIdOrNull } = require("../db/rowMappers");
const AppError = require("../utils/AppError");

function mapLineItemRow(row) {
  return {
    description: row.description,
    type: row.type,
    quantity: row.quantity,
    unitPrice: toMoney(row.unit_price),
    amount: toMoney(row.amount),
    product: toId(row.product_id) || undefined,
    categoryName: row.category_name || undefined,
    consumer: row.consumer || undefined,
    consumerPlayer: toId(row.consumer_player_id) || undefined,
    cafeOrder: toId(row.cafe_order_id) || undefined,
  };
}

function mapPlayerRow(row) {
  return {
    name: row.name,
    result: row.result,
    player: toId(row.player_id) || undefined,
    team: row.team ?? undefined,
    shareAmount: toMoney(row.share_amount),
    paidAmount: toMoney(row.paid_amount),
    gameShare: toMoney(row.game_share),
    cafeShare: toMoney(row.cafe_share),
  };
}

// The same plain-object shape Bill.js's .toJSON() produces (Bill.js's own "balanceDue" virtual
// is the schema's generated balance_due column, step 2.3 - always in sync, not computed here).
function mapBillRow(row, lineItemRows, playerRows) {
  if (!row) return null;
  return {
    id: toId(row.id),
    billNumber: row.bill_number,
    session: toId(row.session_id),
    table: toId(row.table_id),
    tableNumber: row.table_number,
    tableName: row.table_name,
    sessionStartedAt: row.session_started_at,
    sessionEndedAt: row.session_ended_at,
    durationSeconds: row.duration_seconds,
    billedMinutes: row.billed_minutes,
    gameMode: row.game_mode,
    quantity: row.quantity,
    unitPrice: toMoney(row.unit_price),
    pricingType: row.pricing_type || undefined,
    match: toId(row.match_id) || undefined,
    matchNumber: row.match_number ?? undefined,
    winningTeam: row.winning_team ?? undefined,
    losingTeam: row.losing_team ?? undefined,
    lineItems: lineItemRows.map(mapLineItemRow),
    subtotal: toMoney(row.subtotal),
    taxEnabled: row.tax_enabled,
    taxRateBasisPoints: row.tax_rate_basis_points,
    taxAmount: toMoney(row.tax_amount),
    total: toMoney(row.total),
    payerRule: row.payer_rule,
    cafePayerRule: row.cafe_payer_rule,
    players: playerRows.map(mapPlayerRow),
    amountPaid: toMoney(row.amount_paid),
    status: row.status,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    createdBy: actorFromRow(row, "created_by"),
    cancelledBy: actorFromRow(row, "cancelled_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    balanceDue: toMoney(row.balance_due),
  };
}

async function getBillById(id) {
  const billResult = await query("SELECT * FROM app.bills WHERE id = $1", [id]);
  if (billResult.rows.length === 0) throw new AppError("Bill not found", 404);
  const [lineItems, players] = await Promise.all([
    query("SELECT * FROM app.bill_line_items WHERE bill_id = $1 ORDER BY position", [id]),
    query("SELECT * FROM app.bill_players WHERE bill_id = $1 ORDER BY position", [id]),
  ]);
  return mapBillRow(billResult.rows[0], lineItems.rows, players.rows);
}

// data: the already-calculated bill (snapshot fields + totals - see the file header). lineItems
// and players are plain arrays IN THE INTENDED ORDER - position is assigned here, from that order.
// One transaction: the bill row, then every line item, then every player - all or nothing. A
// unique-index violation (duplicate bill number, or the session/match partial-unique rules,
// step 2.3) is turned into the same 409 bills.service.js's saveBill() gives for the matching case.
async function createBill(data, lineItems, players, actorUser = null) {
  const actor = actorFrom(actorUser);
  const userId = actor ? actorUserIdOrNull(String(actor.user)) : null;

  return withTransaction(async (client) => {
    let billRow;
    try {
      const result = await client.query(
        `INSERT INTO app.bills (
           bill_number, session_id, table_id, table_number, table_name,
           session_started_at, session_ended_at, duration_seconds, billed_minutes,
           game_mode, quantity, unit_price, pricing_type, match_id, match_number, winning_team, losing_team,
           subtotal, tax_enabled, tax_rate_basis_points, tax_amount, total, payer_rule, cafe_payer_rule,
           created_by_user_id, created_by_name, created_by_username
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         RETURNING *`,
        [
          data.billNumber, data.session, data.table || null, data.tableNumber, data.tableName || "",
          data.sessionStartedAt, data.sessionEndedAt, data.durationSeconds, data.billedMinutes,
          data.gameMode, data.quantity, data.unitPrice, data.pricingType || null, data.match || null,
          data.matchNumber ?? null, data.winningTeam ?? null, data.losingTeam ?? null,
          data.subtotal, Boolean(data.taxEnabled), data.taxRateBasisPoints || 0, data.taxAmount || 0, data.total,
          data.payerRule, data.cafePayerRule || null, userId, actor ? actor.name : null, actor ? actor.username : null,
        ]
      );
      billRow = result.rows[0];
    } catch (error) {
      if (error.code === "23505") throw duplicateBillError(error);
      throw error;
    }

    const lineItemRows = [];
    for (let position = 0; position < lineItems.length; position += 1) {
      const item = lineItems[position];
      const result = await client.query(
        `INSERT INTO app.bill_line_items (
           bill_id, position, type, description, quantity, unit_price, amount,
           product_id, category_name, consumer, consumer_player_id, cafe_order_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          billRow.id, position, item.type, item.description, item.quantity, item.unitPrice, item.amount,
          item.product || null, item.categoryName || null, item.consumer || null, item.consumerPlayer || null, item.cafeOrder || null,
        ]
      );
      lineItemRows.push(result.rows[0]);
    }

    const playerRows = [];
    for (let position = 0; position < players.length; position += 1) {
      const p = players[position];
      const result = await client.query(
        `INSERT INTO app.bill_players (bill_id, position, name, result, player_id, team, share_amount, paid_amount, game_share, cafe_share)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [billRow.id, position, p.name, p.result || null, p.player || null, p.team ?? null, p.shareAmount, p.paidAmount || 0, p.gameShare ?? null, p.cafeShare ?? null]
      );
      playerRows.push(result.rows[0]);
    }

    return mapBillRow(billRow, lineItemRows, playerRows);
  });
}

function duplicateBillError(error) {
  if (error.constraint === "bills_bill_number_key") return new AppError("A bill with this number already exists", 409);
  if (error.constraint === "bills_one_century_per_session") {
    return new AppError("This session's time was just charged on another Century bill. A session can have only one Century bill.", 409);
  }
  if (error.constraint === "bills_one_per_session_no_match") return new AppError("This session already has a bill", 409);
  if (error.constraint === "bills_one_per_session_and_match") return new AppError("This match already has a bill", 409);
  return new AppError("This session already has a bill", 409); // the generic message bills.service.js falls back to
}

module.exports = { createBill, getBillById, mapBillRow };
