// Test helper: create a user in the (throw-away) test database and log in through the
// real login endpoint. Returns the cookie to send with later requests.
// Authentication is never bypassed in tests - every request goes through the same checks.

const { User } = require("../../models/User");
const { createUser } = require("../../services/users.service");

const TEST_PASSWORD = "Test-password-123";

async function ensureUser(role, username) {
  if (!(await User.exists({ username }))) {
    await createUser({ name: `Test ${role}`, username, role, password: TEST_PASSWORD });
  }
}

async function loginAs(baseUrl, role = "admin", username = `test-${role}`) {
  await ensureUser(role, username);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });
  if (response.status !== 200) throw new Error(`Test login as ${username} failed: ${response.status}`);
  return response.headers.get("set-cookie").split(";")[0]; // "scp_session=<token>"
}

module.exports = { loginAs, TEST_PASSWORD };
