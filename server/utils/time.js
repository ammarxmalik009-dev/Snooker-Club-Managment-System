// Time helpers. The database stores every time in UTC.
// The club, however, thinks in its own local time (e.g. Asia/Karachi, UTC+5):
// "sessions on 2 October" means 2 Oct 00:00 -> 3 Oct 00:00 *Karachi time*,
// which is 1 Oct 19:00 -> 2 Oct 19:00 in UTC. These helpers do that conversion.

// How far ahead of UTC a timezone is at a given moment, in milliseconds.
// Works for any timezone, including ones with daylight saving time.
function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);

  const wallClockAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"),
                                  value("hour"), value("minute"), value("second"));
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-10-02" + "Asia/Karachi" -> the UTC moment when that day starts in Karachi
function startOfDayInTimeZone(dateText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const midnightAsIfUtc = Date.UTC(year, month - 1, day);

  // First guess with the offset at that moment, then correct once (needed only around DST changes)
  let result = midnightAsIfUtc - timeZoneOffsetMs(new Date(midnightAsIfUtc), timeZone);
  result = midnightAsIfUtc - timeZoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

// The start of the NEXT day (used as an exclusive end: "before 3 Oct 00:00")
function startOfNextDayInTimeZone(dateText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)); // handles month/year ends
  return startOfDayInTimeZone(next.toISOString().slice(0, 10), timeZone);
}

// A club-local date + time -> the UTC moment.
// ("2026-10-07", "18:30", "Asia/Karachi") -> 2026-10-07T13:30:00Z
function zonedDateTimeToUtc(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hours, minutes] = timeText.split(":").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hours, minutes);

  // Same correction as startOfDayInTimeZone (the second step only matters around DST changes)
  let result = wallClockAsUtc - timeZoneOffsetMs(new Date(wallClockAsUtc), timeZone);
  result = wallClockAsUtc - timeZoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

// The calendar date of a moment in a timezone: (now, "Asia/Karachi") -> "2026-10-05"
function dateInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

// Whole seconds between two moments (never negative)
function secondsBetween(start, end) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

// Calendar maths on "YYYY-MM-DD" texts (no timezone involved): ("2026-10-31", 1) -> "2026-11-01"
function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Number of calendar days from one date to another, both included: ("2026-10-01", "2026-10-05") -> 5
function daysInRange(fromText, toText) {
  return Math.round((Date.parse(`${toText}T00:00:00Z`) - Date.parse(`${fromText}T00:00:00Z`)) / 86_400_000) + 1;
}

// A moment as club-local text for exports: -> "2026-10-05 18:30"
function formatInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

module.exports = {
  timeZoneOffsetMs,
  startOfDayInTimeZone,
  startOfNextDayInTimeZone,
  zonedDateTimeToUtc,
  dateInTimeZone,
  secondsBetween,
  shiftDate,
  daysInRange,
  formatInTimeZone,
};
