// Recording money received for a bill.
//
// Overpayment can never happen, even if two people record payments at the same moment:
// the database adds the payment ONLY IF, at that exact moment,
//   - the bill is still unpaid / partially paid,
//   - the new total paid stays <= the bill total, and
//   - the paying player's own total stays <= their share.
// All of this is one atomic update - there is no gap between "check" and "save".

const { Bill } = require("../models/Bill");
const { Payment } = require("../models/Payment");
const AppError = require("../utils/AppError");
const { formatMoney } = require("../utils/money");
const { actorFrom } = require("../models/schemas/actor");

function statusFor(amountPaid, total) {
  if (amountPaid <= 0) return "unpaid";
  return amountPaid >= total ? "paid" : "partially_paid";
}

async function recordPayment(billId, { amount, method, payerName, note = "" }, actorUser = null) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new AppError("Bill not found", 404);

  if (bill.status === "cancelled") throw new AppError(`Bill ${bill.billNumber} is cancelled`, 409);
  if (bill.status === "paid") throw new AppError(`Bill ${bill.billNumber} is already fully paid`, 409);

  // The payer must be one of the bill's players who owes something
  const player = bill.players.find((p) => p.name.toLowerCase() === payerName.toLowerCase());
  if (!player) {
    throw new AppError(`${payerName} is not a player on this bill`, 400, [{ field: "payerName", message: "Choose a player from this bill" }]);
  }
  if (player.shareAmount === 0) {
    throw new AppError(`${player.name} doesn't owe anything on this bill`, 409, [{ field: "payerName", message: "This player owes nothing" }]);
  }

  // 1. Add the money - only if every rule still holds at this moment (atomic)
  const updated = await Bill.findOneAndUpdate(
    {
      _id: bill._id,
      status: { $in: ["unpaid", "partially_paid"] },
      amountPaid: { $lte: bill.total - amount },
      players: { $elemMatch: { name: player.name, paidAmount: { $lte: player.shareAmount - amount } } },
    },
    { $inc: { amountPaid: amount, "players.$.paidAmount": amount } },
    { returnDocument: "after" }
  );

  if (!updated) {
    // Explain why, using fresh numbers
    const fresh = await Bill.findById(bill._id);
    const freshPlayer = fresh.players.find((p) => p.name === player.name);
    const billBalance = fresh.total - fresh.amountPaid;
    const playerBalance = freshPlayer.shareAmount - freshPlayer.paidAmount;

    if (fresh.status === "paid" || billBalance <= 0) throw new AppError(`Bill ${fresh.billNumber} is already fully paid`, 409);
    if (fresh.status === "cancelled") throw new AppError(`Bill ${fresh.billNumber} is cancelled`, 409);
    if (amount > billBalance) {
      throw new AppError(`Payment of ${formatMoney(amount)} is more than the remaining balance of ${formatMoney(billBalance)}`, 409, [
        { field: "amount", message: `At most ${formatMoney(billBalance)}` },
      ]);
    }
    throw new AppError(`${player.name} only owes ${formatMoney(playerBalance)} more`, 409, [
      { field: "amount", message: `At most ${formatMoney(playerBalance)} for ${player.name}` },
    ]);
  }

  // 2. Update the status. The condition makes sure a newer payment's status isn't overwritten.
  const status = statusFor(updated.amountPaid, updated.total);
  await Bill.updateOne({ _id: updated._id, amountPaid: updated.amountPaid }, { $set: { status } });
  updated.status = status;

  // 3. Save the payment record. If that fails, take the money back off the bill.
  try {
    const payment = await Payment.create({
      bill: updated._id, amount, method, payerName: player.name, note, paidAt: new Date(),
      receivedBy: actorFrom(actorUser), // which logged-in user took the money
    });
    return { payment, bill: updated };
  } catch (error) {
    const reverted = await Bill.findOneAndUpdate(
      { _id: updated._id, "players.name": player.name },
      { $inc: { amountPaid: -amount, "players.$.paidAmount": -amount } },
      { returnDocument: "after" }
    );
    await Bill.updateOne(
      { _id: reverted._id, amountPaid: reverted.amountPaid },
      { $set: { status: statusFor(reverted.amountPaid, reverted.total) } }
    );
    throw error;
  }
}

module.exports = { recordPayment, statusFor };
