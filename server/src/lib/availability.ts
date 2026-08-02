/**
 * Daily availability windows for a test.
 *
 * Two shapes, because the two obvious requests are opposites:
 *
 *   ALLOW_WINDOW  only attemptable inside the window - "school hours, 08:00
 *                 to 15:00, Monday to Friday"
 *   BLOCK_WINDOW  never attemptable inside it - "paused between 23:00 and
 *                 05:00 every night"
 *
 * Everything here is wall-clock time in the school's own timezone, not the
 * server's. A window of 08:00 is meaningless without knowing whose 08:00, and
 * the container runs UTC, so evaluating against `new Date()` directly would be
 * out by hours. `Intl` does the conversion; no timezone library is needed and
 * no offset is ever hard-coded.
 *
 * These are pure functions over an injected `now`, so the awkward cases -
 * midnight wrap, weekday selection, the minute either side of a boundary - are
 * testable without waiting until 11 PM to find out.
 */

export type AvailabilityMode = 'ALWAYS' | 'ALLOW_WINDOW' | 'BLOCK_WINDOW';

export interface WindowConfig {
  availabilityMode: AvailabilityMode;
  /** Minutes from local midnight, 0..1439. */
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  /** 0 = Sunday .. 6 = Saturday. Empty means every day. */
  windowDays: number[];
}

export interface ZonedNow {
  /** Minutes since local midnight. */
  minuteOfDay: number;
  /** 0 = Sunday .. 6 = Saturday, in the school's timezone. */
  weekday: number;
}

const DAY = 1440;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Reads the wall clock in a given IANA timezone. */
export function zonedNow(timezone: string, now: Date = new Date()): ZonedNow {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch {
    // An invalid timezone must not take the exam system down; fall back to UTC
    // and let the admin notice the window behaving oddly.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  }

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  // hour12:false yields 24 for midnight in some ICU versions.
  const hour = get('hour') % 24;
  const minuteOfDay = hour * 60 + get('minute');

  // Weekday of the *local* calendar date, obtained by treating that date as
  // UTC. Safe because we only read the day-of-week, never the instant.
  const weekday = new Date(Date.UTC(get('year'), get('month') - 1, get('day'))).getUTCDay();

  return { minuteOfDay, weekday };
}

function normaliseMinute(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n >= 0 && n < DAY ? n : null;
}

/**
 * Is `now` inside the configured window?
 *
 * A window that wraps past midnight (23:00 to 05:00) is two spans: from the
 * start to midnight on the starting weekday, and from midnight to the end on
 * the *following* weekday. The weekday filter is applied to the day the window
 * opened, so "Friday 23:00 to 05:00" still covers early Saturday morning.
 */
export function isWithinWindow(config: WindowConfig, now: ZonedNow): boolean {
  const start = normaliseMinute(config.windowStartMinute);
  const end = normaliseMinute(config.windowEndMinute);
  if (start === null || end === null || start === end) return false;

  const days = config.windowDays ?? [];
  const dayAllowed = (weekday: number) => days.length === 0 || days.includes(weekday);

  if (start < end) {
    // Ordinary same-day window.
    return now.minuteOfDay >= start && now.minuteOfDay < end && dayAllowed(now.weekday);
  }

  // Wraps past midnight.
  if (now.minuteOfDay >= start) return dayAllowed(now.weekday);          // evening portion
  if (now.minuteOfDay < end) return dayAllowed((now.weekday + 6) % 7);   // morning portion, opened yesterday
  return false;
}

export interface Availability {
  open: boolean;
  /** Shown to the student when it is closed. */
  reason: string | null;
  /** Plain-English description of the rule, shown either way. */
  windowLabel: string | null;
}

/**
 * Decides whether a test may be attempted right now. This governs *starting*
 * and *resuming* an attempt; an attempt already under way is handled by the
 * caller, which may let it finish or auto-submit it.
 */
export function evaluateAvailability(config: WindowConfig, timezone: string, now: Date = new Date()): Availability {
  if (config.availabilityMode === 'ALWAYS') {
    return { open: true, reason: null, windowLabel: null };
  }

  const label = describeWindow(config);
  const inside = isWithinWindow(config, zonedNow(timezone, now));

  if (config.availabilityMode === 'ALLOW_WINDOW') {
    return inside
      ? { open: true, reason: null, windowLabel: label }
      : { open: false, reason: `This test can only be attempted ${label}.`, windowLabel: label };
  }

  // BLOCK_WINDOW
  return inside
    ? { open: false, reason: `This test is paused ${label}.`, windowLabel: label }
    : { open: true, reason: null, windowLabel: label };
}

// --- Formatting ------------------------------------------------------------

export function formatMinute(minute: number): string {
  const m = ((Math.trunc(minute) % DAY) + DAY) % DAY;
  const hour24 = Math.floor(m / 60);
  const mins = m % 60;
  const suffix = hour24 < 12 ? 'am' : 'pm';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(mins).padStart(2, '0')}${suffix}`;
}

/** Turns [1,2,3,4,5] into "Mon to Fri", [0,6] into "Sat and Sun". */
export function describeDays(days: number[]): string {
  const unique = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (unique.length === 0 || unique.length === 7) return 'every day';
  if (unique.length === 1) return `on ${DAY_NAMES[unique[0]]}s`;

  // Contiguous run, e.g. Mon-Fri.
  const contiguous = unique.every((d, i) => i === 0 || d === unique[i - 1] + 1);
  if (contiguous) return `${DAY_SHORT[unique[0]]} to ${DAY_SHORT[unique[unique.length - 1]]}`;

  const names = unique.map((d) => DAY_SHORT[d]);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function describeWindow(config: WindowConfig): string {
  const start = normaliseMinute(config.windowStartMinute);
  const end = normaliseMinute(config.windowEndMinute);
  if (start === null || end === null) return 'at the configured times';

  const days = describeDays(config.windowDays ?? []);
  const dayPart = days === 'every day' ? '' : ` ${days}`;
  return `between ${formatMinute(start)} and ${formatMinute(end)}${dayPart}`;
}

/** Common presets offered in the admin UI. */
export const WINDOW_PRESETS = [
  { code: 'school_hours', label: 'School hours (Mon-Fri, 8am-3pm)', mode: 'ALLOW_WINDOW' as const, start: 8 * 60, end: 15 * 60, days: [1, 2, 3, 4, 5] },
  { code: 'school_day_all', label: 'School hours, every day (8am-3pm)', mode: 'ALLOW_WINDOW' as const, start: 8 * 60, end: 15 * 60, days: [] },
  { code: 'overnight_pause', label: 'Paused overnight (11pm-5am)', mode: 'BLOCK_WINDOW' as const, start: 23 * 60, end: 5 * 60, days: [] },
  { code: 'evening_only', label: 'Evenings only (4pm-9pm)', mode: 'ALLOW_WINDOW' as const, start: 16 * 60, end: 21 * 60, days: [] },
];

/** IANA zones offered in Settings. Any valid zone may be typed in. */
export const COMMON_TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles',
  'Australia/Sydney', 'UTC',
];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
