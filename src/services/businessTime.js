// Times are stored in UTC, but "valid for 14 days" means to the end of the
// 14th day where the merchant does business (spec §12 time zones), not to a
// moment that falls in the middle of someone's afternoon.

// How far ahead of UTC `timeZone` is at `instant`, in milliseconds.
function offsetMs(timeZone, instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The last moment (23:59:59.999) of the day that is `days` after `from`, in
// `timeZone`, as a UTC instant. An unknown or UTC zone is end of day in UTC.
function endOfBusinessDay(from, days, timeZone) {
  const zone = timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  }

  // The calendar date there, `days` later.
  const target = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(target);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), 23, 59, 59, 999);

  // Walk from that wall-clock time back to UTC; twice, so a clock change on the
  // day itself still lands on the right side of it.
  let instant = wall - offsetMs(zone, new Date(wall));
  instant = wall - offsetMs(zone, new Date(instant));
  return new Date(instant);
}

module.exports = { endOfBusinessDay, offsetMs };
