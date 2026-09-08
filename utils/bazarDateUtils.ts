/**
 * Bazar items are stored per calendar date, while bazar duty assignments stay
 * on a weekly rotation. These helpers keep both sides on the same convention:
 * weekday 0 is Saturday and weekday 6 is Friday, matching the mobile client.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the `YYYY-MM-DD` string when it is a real calendar date, else null. */
export const parseBazarDate = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!DATE_PATTERN.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
    ? raw
    : null;
};

/** Weekday index (0 = Saturday ... 6 = Friday) a bazar date falls on. */
export const bazarWeekdayFromDate = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  return (new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() + 1) % 7;
};

export const BAZAR_WEEKDAY_NAMES = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;
