// Test helper (Phase 11.8): the ONLY way the server tests delete a database.
//
// Every test file uses its own throw-away database (snooker_club_pro_test_<area>) and empties it
// before and after its tests. If a test database address were ever set to the REAL database
// (for example a mistyped MONGODB_*_TEST_URI), dropDatabase() would delete the club's data.
// So the name is checked first: it must contain "test" - otherwise nothing is deleted and the
// test run stops with a clear error.

const mongoose = require("mongoose");

const TEST_NAME = /test/i;

function assertTestDatabase(connection = mongoose.connection) {
  const name = connection.name;
  if (!name || !TEST_NAME.test(name)) {
    throw new Error(`Refusing to delete the database "${name || "(none)"}": test databases must have "test" in their name. Nothing was deleted.`);
  }
  return name;
}

async function dropTestDatabase(connection = mongoose.connection) {
  assertTestDatabase(connection);
  await connection.dropDatabase();
}

module.exports = { assertTestDatabase, dropTestDatabase };
