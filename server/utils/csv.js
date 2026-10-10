// Builds CSV files (for the report exports) that open correctly in Excel and Google Sheets.
//
// Safety:
//  - Values with commas, quotes or line breaks are wrapped in quotes ("" inside = one quote).
//  - "CSV injection": a cell that starts with = + - @ could run as a formula in a spreadsheet.
//    Such text (e.g. a player named "=HYPERLINK(...)") gets a ' in front, so it stays plain text.
//    Plain numbers like "-5" or "1200.50" are left alone.

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// headers: ["Date", "Billed (Rs)"], rows: [["2026-10-05", "1200.00"], ...]
// Starts with a "byte order mark" so Excel reads the file as UTF-8 (names like "Café" stay correct).
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

// Whole paisa -> rupees text with 2 decimals for spreadsheets: 120050 -> "1200.50"
function paisaToRupees(paisa) {
  if (!Number.isInteger(paisa)) return "";
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

module.exports = { csvCell, toCsv, paisaToRupees };
