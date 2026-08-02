import { prisma } from '../db.js';
import { isValidTimezone } from '../lib/availability.js';

/**
 * Loose application settings, kept in the Setting key/value table so a new
 * toggle never needs a migration.
 */

export const SETTING_KEYS = {
  timezone: 'school.timezone',
} as const;

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * The school's timezone, used to evaluate every daily availability window.
 *
 * Cached for a minute: it is read on every dashboard load and every attempt
 * start, and it changes perhaps once in the life of the system.
 */
let cache: { value: string; readAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSchoolTimezone(): Promise<string> {
  if (cache && Date.now() - cache.readAt < TTL_MS) return cache.value;

  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.timezone } }).catch(() => null);
  const stored = typeof row?.value === 'string' ? row.value : null;
  const value = stored && isValidTimezone(stored) ? stored : DEFAULT_TIMEZONE;

  cache = { value, readAt: Date.now() };
  return value;
}

export async function setSchoolTimezone(timezone: string): Promise<string> {
  if (!isValidTimezone(timezone)) {
    throw new Error(`"${timezone}" is not a recognised timezone. Use an IANA name such as Asia/Kolkata.`);
  }
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.timezone },
    update: { value: timezone },
    create: { key: SETTING_KEYS.timezone, value: timezone },
  });
  cache = { value: timezone, readAt: Date.now() };
  return timezone;
}

/** Drops the cache, so a restore or a direct edit is picked up promptly. */
export function invalidateSettingsCache() {
  cache = null;
}
