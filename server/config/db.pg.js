// Optional PostgreSQL connection foundation (Phase 2, step 2.2 - see docs/POSTGRES_MIGRATION.md).
// MongoDB/Mongoose (server/config/db.js) is still the app's real database and is NOT touched by
// this file. Nothing here runs automatically: requiring this module opens no connection, and
// nothing elsewhere in the app requires it yet.
//
//   getPool()               the shared connection pool. Created the first time it's actually
//                           needed (not just by requiring this file), from DATABASE_URL in .env.
//                           Throws a clear error if DATABASE_URL isn't set.
//   query(text, params)     one query through the pool.
//   withTransaction(fn)     one client: BEGIN, then fn(client), then COMMIT - or ROLLBACK if fn
//                           throws. The client is always released back to the pool.
//   closePool()             closes the pool and every connection in it. Nothing calls this on its
//                           own - call it yourself when done (e.g. a test's `after` hook).
//
// SQL injection: text's placeholders ($1, $2, ...) and the matching params array are how every
// value reaches the database. NEVER build `text` by joining or interpolating a value into the
// string yourself - that is exactly what parameterized queries exist to prevent.

const { Pool } = require("pg");
const env = require("./env");

let pool = null;

// The address and database name only - never the user name or password. Same idea as
// safeMongoTarget in db.js, for anything that might need to mention the target in a log or error.
function safePgTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(the address in DATABASE_URL)";
  }
}

// Creates the pool on first use only. A missing DATABASE_URL is refused here, with a message that
// says what to do - not a confusing low-level error from `pg` trying to guess a default address.
function getPool() {
  if (pool) return pool;
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. PostgreSQL support is optional (Phase 2) - set DATABASE_URL in " +
        ".env first (see .env.example) before anything tries to use it."
    );
  }
  pool = new Pool({ connectionString: env.databaseUrl });
  // A background connection in the pool can fail on its own (e.g. the server restarted). `pg`
  // requires every pool to have an error listener, or that failure would crash the process.
  pool.on("error", (error) => {
    console.error(`PostgreSQL pool error (${safePgTarget(env.databaseUrl)}): ${error.message}`);
  });
  return pool;
}

// One query through the pool. Always async, even when getPool() throws synchronously (a missing
// DATABASE_URL) - callers can always `await` or `.catch()` this, consistently.
async function query(text, params = []) {
  return getPool().query(text, params);
}

// Runs fn(client) inside one transaction. On success: COMMIT and return fn's result. On any
// error from fn: ROLLBACK, then re-throw that SAME error (not the rollback's) - whoever called
// withTransaction must see why the transaction actually failed. If the rollback itself also fails
// (e.g. the connection just died), that is attached as error.rollbackError for diagnosis, without
// replacing the original error. The client is released back to the pool in every case.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

// Closes the pool (and every connection in it). Safe to call even if getPool() was never called -
// there is then simply nothing to close.
async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

module.exports = { getPool, query, withTransaction, closePool, safePgTarget };
