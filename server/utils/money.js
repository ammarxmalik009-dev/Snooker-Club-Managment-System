// Server-side money text for error messages: 120050 -> "Rs 1,200.50"
// (The browser has its own copy in client/js/core/format.js for the pages.)

const CURRENCY_SYMBOL = "Rs";

function formatMoney(paisa) {
  const sign = paisa < 0 ? "-" : "";
  const absolute = Math.abs(paisa);
  const rupees = Math.floor(absolute / 100).toLocaleString("en-US");
  const cents = String(absolute % 100).padStart(2, "0");
  return `${sign}${CURRENCY_SYMBOL} ${rupees}.${cents}`;
}

module.exports = { formatMoney };
