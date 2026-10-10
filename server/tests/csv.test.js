// Unit tests for the CSV builder and the calendar helpers used by the reports (Phase 9).

const test = require("node:test");
const assert = require("node:assert/strict");
const { csvCell, toCsv, paisaToRupees } = require("../utils/csv");
const { shiftDate, daysInRange, formatInTimeZone } = require("../utils/time");

test("csvCell: commas, quotes and line breaks are quoted; formulas are made harmless", () => {
  assert.equal(csvCell("Ali"), "Ali");
  assert.equal(csvCell("Main, Hall"), '"Main, Hall"');
  assert.equal(csvCell('Sam "the" Cue'), '"Sam ""the"" Cue"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(" padded "), '" padded "');
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("+92 300"), "'+92 300");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell("@user"), "'@user");
  assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  assert.equal(csvCell("-12.50"), "-12.50", "plain numbers stay numbers");
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("toCsv: UTF-8 byte order mark, header row, CRLF line ends", () => {
  assert.equal(toCsv(["A", "B"], [["1", "x,y"], ["Café", ""]]), '﻿A,B\r\n1,"x,y"\r\nCafé,\r\n');
});

test("paisaToRupees: exact two-decimal text, no floating point", () => {
  assert.equal(paisaToRupees(120050), "1200.50");
  assert.equal(paisaToRupees(5), "0.05");
  assert.equal(paisaToRupees(0), "0.00");
  assert.equal(paisaToRupees(-250), "-2.50");
  assert.equal(paisaToRupees(1.5), "");
});

test("calendar helpers: shiftDate, daysInRange, formatInTimeZone", () => {
  assert.equal(shiftDate("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDate("2028-03-01", -1), "2028-02-29", "leap year");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(daysInRange("2026-10-01", "2026-10-05"), 5);
  assert.equal(daysInRange("2026-10-05", "2026-10-05"), 1);
  assert.equal(daysInRange("2025-10-01", "2026-09-30"), 365);
  assert.equal(formatInTimeZone(new Date("2026-10-05T13:30:00Z"), "Asia/Karachi"), "2026-10-05 18:30");
  assert.equal(formatInTimeZone(new Date("2026-10-05T19:00:00Z"), "Asia/Karachi"), "2026-10-06 00:00", "midnight is 00:00, not 24:00");
});
