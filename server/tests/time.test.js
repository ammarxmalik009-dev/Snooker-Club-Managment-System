// Tests for server/utils/time.js (club-local day boundaries).

const test = require("node:test");
const assert = require("node:assert/strict");
const { startOfDayInTimeZone, startOfNextDayInTimeZone, secondsBetween, zonedDateTimeToUtc } = require("../utils/time");

test("zonedDateTimeToUtc: club-local booking times become the right UTC moments", () => {
  assert.equal(zonedDateTimeToUtc("2026-10-07", "18:30", "Asia/Karachi").toISOString(), "2026-10-07T13:30:00.000Z");
  assert.equal(zonedDateTimeToUtc("2026-10-07", "00:00", "Asia/Karachi").toISOString(), "2026-10-06T19:00:00.000Z");
  assert.equal(zonedDateTimeToUtc("2026-10-07", "23:30", "Asia/Karachi").toISOString(), "2026-10-07T18:30:00.000Z");
  // London: 29 Mar 2026 10:00 is already summer time (UTC+1)
  assert.equal(zonedDateTimeToUtc("2026-03-29", "10:00", "Europe/London").toISOString(), "2026-03-29T09:00:00.000Z");
  assert.equal(zonedDateTimeToUtc("2026-03-28", "10:00", "Europe/London").toISOString(), "2026-03-28T10:00:00.000Z");
});

test("Asia/Karachi (UTC+5): a club day starts at 19:00 UTC the evening before", () => {
  assert.equal(startOfDayInTimeZone("2026-10-02", "Asia/Karachi").toISOString(), "2026-10-01T19:00:00.000Z");
  assert.equal(startOfNextDayInTimeZone("2026-10-02", "Asia/Karachi").toISOString(), "2026-10-02T19:00:00.000Z");
});

test("month and year ends roll over correctly", () => {
  assert.equal(startOfNextDayInTimeZone("2026-12-31", "Asia/Karachi").toISOString(), "2026-12-31T19:00:00.000Z");
  assert.equal(startOfNextDayInTimeZone("2028-02-28", "Asia/Karachi").toISOString(), "2028-02-28T19:00:00.000Z"); // leap year: 29 Feb
});

test("timezones with daylight saving time are handled", () => {
  // London: clocks go forward on 29 Mar 2026 at 01:00 UTC
  assert.equal(startOfDayInTimeZone("2026-03-29", "Europe/London").toISOString(), "2026-03-29T00:00:00.000Z");
  assert.equal(startOfDayInTimeZone("2026-03-30", "Europe/London").toISOString(), "2026-03-29T23:00:00.000Z");
  // New York: clocks go back on 1 Nov 2026
  assert.equal(startOfDayInTimeZone("2026-11-01", "America/New_York").toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(startOfDayInTimeZone("2026-11-02", "America/New_York").toISOString(), "2026-11-02T05:00:00.000Z");
});

test("secondsBetween counts whole seconds and is never negative", () => {
  const start = new Date("2026-10-02T10:00:00.000Z");
  assert.equal(secondsBetween(start, new Date("2026-10-02T11:05:03.999Z")), 3903);
  assert.equal(secondsBetween(start, new Date("2026-10-02T09:59:00.000Z")), 0);
});
