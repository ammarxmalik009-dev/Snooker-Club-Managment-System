// format.js - turns stored values into nice text, and form text back into stored values.
// Money is ALWAYS a whole number of paisa (Rs 600.50 = 60050). We use string maths
// for converting, never decimal floats, so there are no rounding errors.

// Club currency and timezone, fixed in the app (a known limitation, see README). The server uses the same
// timezone (CLUB_TIMEZONE in .env) to decide what "a day" is for date filters.
const CURRENCY = { code: "PKR", symbol: "Rs" };
const CLUB_TIME_ZONE = "Asia/Karachi";

// 60050 -> "Rs 600.50"    1234500 -> "Rs 12,345.00"
function formatMoney(paisa) {
    if (!Number.isInteger(paisa)) return "—";
    const sign = paisa < 0 ? "-" : "";
    const absolute = Math.abs(paisa);
    const rupees = Math.floor(absolute / 100).toLocaleString("en-US");
    const cents = String(absolute % 100).padStart(2, "0");
    return `${sign}${CURRENCY.symbol} ${rupees}.${cents}`;
}

// What the user typed -> paisa.  "600" -> 60000, "600.5" -> 60050, "1,200.75" -> 120075
// Returns null when the text is not a valid amount (letters, negative, more than 2 decimals).
function parseMoneyInput(text) {
    const cleaned = String(text).trim().replace(/,/g, "");
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
    if (!match) return null;

    const rupees = Number(match[1]);
    const paisa = Number((match[2] || "").padEnd(2, "0")); // "5" -> "50" -> 50
    const total = rupees * 100 + paisa;
    return Number.isSafeInteger(total) ? total : null;
}

// paisa -> text for an input box: 60050 -> "600.50"
function paisaToInput(paisa) {
    return `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, "0")}`;
}

// ---------- Billing labels ----------
const BILL_STATUS_LABELS = { unpaid: "Unpaid", partially_paid: "Partially paid", paid: "Paid", cancelled: "Cancelled" };
const PAYMENT_METHOD_LABELS = {
    cash: "Cash", card: "Card", jazzcash: "JazzCash", easypaisa: "Easypaisa", bank_transfer: "Bank transfer", other: "Other",
};
// "split" is still the stored value (old bills keep it) and is shown as "Both Pay" (was "Split equally").
// "split_equally" never was a stored value here, but any record that has it is read the same way.
const PAYER_RULE_LABELS = { loser: "Loser Pays", winner: "Winner Pays", split: "Both Pay", split_equally: "Both Pay" };
// ---------- Game modes (Phase 11.1) ----------
// The list of game modes comes from the server's registry (GET /api/game-modes) - never typed here.
// layout.js loads it once per page; until it has arrived, a key is shown in a readable form
// ("century" -> "Century"), which is also how keys of very old or unknown modes are shown.
let gameModesCache = null;

async function loadGameModes() {
    if (!gameModesCache) gameModesCache = (await apiRequest("/game-modes")).data;
    return gameModesCache;
}

function findGameMode(key) {
    return (gameModesCache || []).find((mode) => mode.key === key) || null;
}

// "century" -> "Century", "four_player" -> "4 Players" (after loading), unknown -> "Some mode"
function gameModeLabel(key) {
    const mode = findGameMode(key);
    if (mode) return mode.label;
    const text = String(key || "").replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// The counted unit of a mode: ("frame", 2) -> "frames"
function gameModeQuantityLabel(key, quantity = 2) {
    const mode = findGameMode(key);
    if (!mode) return "played";
    return quantity === 1 ? mode.quantityLabel.one : mode.quantityLabel.many;
}

// ---------- Café labels (Phase 10) ----------
const CAFE_PAYER_RULE_LABELS = { loser: "Loser Pays", consumer: "Consumer Pays", split: "Both Pay", split_equally: "Both Pay" };
const STOCK_MOVEMENT_LABELS = {
    initial: "Starting stock", restock: "Restock", sale: "Sale", sale_reversal: "Sale reversed (bill cancelled)",
    adjustment: "Adjustment", waste: "Waste",
};

// ---------- Booking labels & club-local dates (Phase 7) ----------
const BOOKING_STATUS_LABELS = {
    pending: "Pending", confirmed: "Confirmed", completed: "Checked in", cancelled: "Cancelled", no_show: "No-show",
};

// "6:00 pm – 7:30 pm"
function formatTimeRange(startIso, endIso) {
    return `${formatTime(startIso)} – ${formatTime(endIso)}`;
}

// A moment -> its club-local date "2026-10-07" and time "18:30" (for edit forms)
function clubDateOf(isoText) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE }).format(new Date(isoText));
}
function clubTimeOf(isoText) {
    return new Date(isoText).toLocaleTimeString("en-GB", { timeZone: CLUB_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });
}

// "2026-10-07" + 1 -> "2026-10-08" (pure calendar maths, no timezone involved)
function addDays(dateText, days) {
    const date = new Date(`${dateText}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

// "2026-10-07" -> "Tuesday, 7 October 2026"
function formatLongDate(dateText) {
    return new Date(`${dateText}T12:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
}

// Tax rates are stored in "basis points": 1600 -> "16%", 1650 -> "16.5%"
function formatPercent(basisPoints) {
    return `${Number((basisPoints / 100).toFixed(2))}%`;
}

// Minutes as "1h 05m" / "50m"
function formatMinutes(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

// "maintenance" -> "Maintenance"
function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// ---------- Time ----------

// Live timer style: 3903 -> "01:05:03"  (hours keep counting past 24: "26:00:00")
function formatTimer(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

// Readable duration: 3903 -> "1h 05m 03s", 125 -> "2m 05s", 9 -> "9s"
function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return "—";
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${rest}s`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${seconds}s`;
}

// Dates are always shown in the CLUB's timezone, whatever the computer is set to.
// "2026-10-02T12:25:00Z" -> "2 Oct 2026, 5:25 pm"
function formatDateTime(isoText) {
    if (!isoText) return "—";
    return new Date(isoText).toLocaleString("en-GB", {
        timeZone: CLUB_TIME_ZONE,
        day: "numeric", month: "short", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
    });
}

// "2026-10-02T12:25:00Z" -> "5:25 pm"
function formatTime(isoText) {
    if (!isoText) return "—";
    return new Date(isoText).toLocaleTimeString("en-GB", {
        timeZone: CLUB_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true,
    });
}

// Today's date in the club as "YYYY-MM-DD" (for date filters)
function todayInClub() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE }).format(new Date());
}
