import type { Prisma } from '@prisma/client';

/**
 * Username = firstname + lastname, no spaces, lowercased, with a numeric
 * suffix only when that base is already taken:
 *   Rahul Sharma        -> rahulsharma
 *   second Rahul Sharma -> rahulsharma1
 *   third Rahul Sharma  -> rahulsharma2
 *
 * Accents are folded and non-letters stripped so the result is always safe to
 * type and to put in a URL.
 */

// Unicode combining-marks range, left as an escape so the source stays ASCII.
const COMBINING_MARKS = /[̀-ͯ]/g;

export function baseUsername(firstName: string, lastName: string): string {
  const clean = (s: string) =>
    s
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const base = `${clean(firstName)}${clean(lastName)}`;
  // Guard against a name that reduces to nothing (e.g. entirely non-Latin).
  return base.length > 0 ? base.slice(0, 40) : 'student';
}

/**
 * Finds the next free username. Must run inside the same transaction as the
 * user INSERT, otherwise two simultaneous signups can pick the same suffix.
 * The caller also handles the unique-constraint retry as a second line of
 * defence.
 */
export async function allocateUsername(
  tx: Prisma.TransactionClient,
  firstName: string,
  lastName: string,
): Promise<string> {
  const base = baseUsername(firstName, lastName);

  const taken = await tx.user.findMany({
    where: { username: { startsWith: base } },
    select: { username: true },
  });
  const takenSet = new Set(taken.map((u) => u.username));

  if (!takenSet.has(base)) return base;

  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}${i}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a username for this name.');
}
