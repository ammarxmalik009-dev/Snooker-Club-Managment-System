// The "counters" collection: running numbers, e.g. how many bills were made today.
// { _id: "bill-2026-10-05", seq: 7 }  -> the next bill that day is number 8.
// Increasing happens in one atomic database step, so two bills can never get the same number.

const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

const Counter = mongoose.model("Counter", counterSchema);

async function nextSequence(name) {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" } // creates the counter the first time
  );
  return counter.seq;
}

module.exports = { Counter, nextSequence };
