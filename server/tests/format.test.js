// Tests for client/js/core/format.js (the money helpers the browser uses).
// The browser file is loaded into a small sandbox, so we test the exact same code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "client", "js", "core", "format.js"), "utf8");
const sandbox = {};
vm.runInNewContext(
  `${source}; Object.assign(globalThis.exports, { formatMoney, parseMoneyInput, paisaToInput, capitalize,
     formatTimer, formatDuration, formatDateTime, formatTime });`,
  Object.assign(sandbox, { exports: {}, Intl, Date })
);
const { formatMoney, parseMoneyInput, paisaToInput, capitalize, formatTimer, formatDuration, formatDateTime, formatTime } =
  sandbox.exports;

test("parseMoneyInput turns typed amounts into exact paisa", () => {
  assert.equal(parseMoneyInput("600"), 60000);
  assert.equal(parseMoneyInput("600.5"), 60050);
  assert.equal(parseMoneyInput("600.50"), 60050);
  assert.equal(parseMoneyInput("0.1"), 10);
  assert.equal(parseMoneyInput("0.29"), 29); // 0.29 * 100 is 28.999… with floats - not here
  assert.equal(parseMoneyInput("1,200.75"), 120075);
  assert.equal(parseMoneyInput("  45 "), 4500);
  assert.equal(parseMoneyInput("0"), 0);
});

test("parseMoneyInput rejects invalid amounts", () => {
  for (const bad of ["", "abc", "-5", "1.234", "12.", ".5", "1e3", "Rs 50", "5,00.0.0"]) {
    assert.equal(parseMoneyInput(bad), null, `"${bad}" should be rejected`);
  }
});

test("formatMoney shows paisa as rupees", () => {
  assert.equal(formatMoney(60050), "Rs 600.50");
  assert.equal(formatMoney(0), "Rs 0.00");
  assert.equal(formatMoney(5), "Rs 0.05");
  assert.equal(formatMoney(123456789), "Rs 1,234,567.89");
  assert.equal(formatMoney(-2500), "-Rs 25.00");
  assert.equal(formatMoney(undefined), "—");
});

test("paisaToInput and capitalize", () => {
  assert.equal(paisaToInput(60050), "600.50");
  assert.equal(paisaToInput(7), "0.07");
  assert.equal(paisaToInput(60000), "600.00");
  assert.equal(parseMoneyInput(paisaToInput(123456)), 123456); // round trip
  assert.equal(capitalize("maintenance"), "Maintenance");
});

test("formatTimer shows HH:MM:SS and keeps counting past 24 hours", () => {
  assert.equal(formatTimer(0), "00:00:00");
  assert.equal(formatTimer(3903), "01:05:03");
  assert.equal(formatTimer(59.9), "00:00:59");
  assert.equal(formatTimer(26 * 3600), "26:00:00");
  assert.equal(formatTimer(-5), "00:00:00");
});

test("formatDuration is readable", () => {
  assert.equal(formatDuration(3903), "1h 05m 03s");
  assert.equal(formatDuration(125), "2m 05s");
  assert.equal(formatDuration(9), "9s");
  assert.equal(formatDuration(null), "—");
});

test("dates are shown in Karachi time, whatever the computer's timezone", () => {
  // 12:25 UTC = 17:25 in Karachi (UTC+5)
  assert.equal(formatTime("2026-10-02T12:25:00Z"), "5:25 pm");
  assert.equal(formatDateTime("2026-10-02T12:25:00Z"), "2 Oct 2026, 5:25 pm");
  // 19:30 UTC on 1 Oct is already 2 Oct in Karachi
  assert.equal(formatDateTime("2026-10-01T19:30:00Z"), "2 Oct 2026, 12:30 am");
  assert.equal(formatDateTime(null), "—");
});
