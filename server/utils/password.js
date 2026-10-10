// Password hashing with scrypt (built into Node.js - no extra package).
// scrypt is deliberately slow and memory-hungry, so guessing passwords is expensive.
// Stored format:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
// The settings are saved with each hash, so they can be raised later without breaking old passwords.

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const COST = { N: 16384, r: 8, p: 1 }; // ~16 MB memory per hash
const KEY_LENGTH = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16); // a new random salt for every password
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, "base64");
  const actual = await scrypt(password, Buffer.from(saltText, "base64"), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected); // compare in constant time
}

// Used when the username doesn't exist, so a failed login takes the same time either way
let dummyHash = null;
async function fakeVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword("not-a-real-password-123");
  await verifyPassword(password, dummyHash);
  return false;
}

// Password rules (also used by the create-admin script). Returns an error message, or null if OK.
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
function passwordProblem(password, username = "") {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Password must contain both letters and numbers";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username";
  if (/^(.)\1+$/.test(password)) return "Password is too simple";
  return null;
}

module.exports = { hashPassword, verifyPassword, fakeVerify, passwordProblem, PASSWORD_MIN };
