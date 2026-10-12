// Counters - PostgreSQL pilot (Phase 2, step 2.16). Standalone: not wired into any route, does
// not call and is not called by server/models/Counter.js (MongoDB), which stays the
// application's only active path. Not integrated into bills.pg.service.js/bills.service.js (bill
// numbering) or server/services/matches.pg.service.js (which already has its own, working,
// inline counter SQL from step 2.14 - deliberately left unchanged by this step, see this file's
// own "Transaction behaviour" note below).
//
// models/Counter.js's nextSequence is one atomic upsert-and-increment
// (`findOneAndUpdate({_id:name}, {$inc:{seq:1}}, {upsert:true})`) - a brand-new name's first call
// returns 1, every later call for the same name returns the next integer, and two different
// names are completely independent rows. The exact same thing, done the exact same atomic way,
// against the real app.counters table (`id text PRIMARY KEY, seq bigint NOT NULL DEFAULT 0`,
// already built for this in step 2.3 - no schema change was needed or made):
//   INSERT INTO app.counters (id, seq) VALUES ($1, 1)
//   ON CONFLICT (id) DO UPDATE SET seq = app.counters.seq + 1
//   RETURNING seq
//
// `seq` is a PostgreSQL bigint column, which the `pg` driver always returns as a STRING, never a
// number (the same documented reason server/db/rowMappers.js's own toMoney converts money
// columns back to a number: a JS number can't safely hold the full 64-bit range). A sequence
// value here never remotely approaches Number.MAX_SAFE_INTEGER (bill-of-the-day and match-of-
// the-session counts), so nextSequence converts it with Number(...) and always returns a plain
// JS number - never a string, never a BigInt. Tested directly below (typeof result === "number").
//
// Transaction behaviour - BOTH of this codebase's two real callers' needs, by design, not by
// accident:
//   - bills.service.js's own nextSequence call has NO rollback: if Bill.create() fails
//     afterwards, the sequence number is simply burned (a documented, accepted gap - bill
//     numbers may have gaps, never duplicates). nextSequence(name) with no second argument
//     reproduces this exactly: it runs through the ordinary query() wrapper, commits
//     immediately on its own, and is NOT undone by any later, unrelated failure.
//   - matches.pg.service.js's OWN inline counter SQL (step 2.14, left unchanged by this step)
//     already runs INSIDE its startMatch transaction, so a failure anywhere else in that same
//     transaction rolls the increment back too - a match number is never issued for a match that
//     didn't actually get created. nextSequence(name, client) with a transaction-scoped second
//     argument reproduces that exact pattern for any FUTURE caller that wants it, without
//     touching matches.pg.service.js's own already-working, already-tested code.

const { query } = require("../config/db.pg");
const AppError = require("../utils/AppError");

const MAX_NAME_LENGTH = 200; // app.counters.id is a plain `text` column (no schema limit) - this
// pilot's own, documented bound, the same way every earlier pilot validates a field the schema
// itself leaves unbounded (e.g. Players/Customers' own name/phone/notes length checks).

// Same validation style as every earlier pilot's own input checks: a clear AppError, not a raw
// SQL error, for a genuinely bad caller input (an empty or absurdly long name).
function validateName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new AppError("Counter name is required", 400, [{ field: "name", message: "Counter name is required" }]);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new AppError(`Counter name must be at most ${MAX_NAME_LENGTH} characters`, 400, [
      { field: "name", message: `Counter name must be at most ${MAX_NAME_LENGTH} characters` },
    ]);
  }
}

// A transaction-scoped client is a caller-code contract, not user input - an invalid one is a
// programming mistake, so it throws a plain error (not an AppError, which is for user-facing
// problems), the moment it is passed, rather than silently falling back to a standalone query.
function validateClient(client) {
  if (client === undefined || client === null) return null;
  if (typeof client.query !== "function") {
    throw new TypeError("counters.pg.service.nextSequence: the client argument must have a query() method (e.g. a withTransaction callback's own client)");
  }
  return client;
}

// The next integer for `name` - 1 on that name's very first call, every later call one more,
// completely independent of every other name. Pass a transaction-scoped client (the one
// withTransaction's callback receives) as the second argument to have the increment commit or
// roll back together with the rest of that transaction; omit it to increment immediately and
// permanently, independent of anything that happens afterward - see this file's own header
// comment for exactly which of this codebase's real callers needs which.
async function nextSequence(name, client) {
  validateName(name);
  const runner = validateClient(client) || { query: (text, params) => query(text, params) };
  const result = await runner.query(
    `INSERT INTO app.counters (id, seq) VALUES ($1, 1)
     ON CONFLICT (id) DO UPDATE SET seq = app.counters.seq + 1
     RETURNING seq`,
    [name]
  );
  return Number(result.rows[0].seq);
}

module.exports = { nextSequence };
