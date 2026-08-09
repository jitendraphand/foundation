/**
 * Whose work an administrator can see.
 *
 * A school runs several people who set papers. One colleague's half-written
 * drafts turning up in another's review queue is noise at best, and at worst two
 * people approve the same question for two different papers without either
 * knowing. The same applies to the papers themselves and to the generation
 * history: "which model did I use for the Chemistry batch, and how many were
 * rejected" is a question about your own work.
 *
 * So questions, tests and generation runs all belong to whoever made them, and
 * one rule decides who sees past that:
 *
 *   content.viewAll  granted deliberately, for the invigilator or head of
 *                    department whose job spans other people's papers
 *   admins.manage    the keys-to-the-kingdom privilege, which already implies
 *                    authority over every other administrator - somebody has to
 *                    be able to audit and clean up
 *
 * Questions are the one table where the author can be missing - they predate
 * authorship being recorded - and those are visible to everybody. Hiding them
 * would strand real work behind a column that was NULL for historical reasons
 * rather than because anybody decided anything. Tests and generation runs have
 * always recorded who made them, so they have no such rows and asking for
 * `createdById: null` there is not merely pointless: Prisma refuses it, because
 * the column is not nullable.
 */

export interface Actor {
  user?: { sub: string; permissions: readonly string[] };
}

export function seesEverything(request: Actor): boolean {
  const permissions = request.user?.permissions ?? [];
  return permissions.includes('content.viewAll') || permissions.includes('admins.manage');
}

/**
 * A Prisma `where` fragment scoping rows to this administrator.
 *
 * `field` is whichever column records the author - createdById on a question or
 * a test, requestedById on a generation run. `sharedWhenUnowned` follows that
 * column's nullability, which is a fact about the schema rather than a choice
 * the caller gets to make; see the note above.
 */
export function ownedBy(
  request: Actor,
  field: 'createdById' | 'requestedById',
  sharedWhenUnowned = false,
) {
  if (seesEverything(request)) return {};
  const mine = { [field]: request.user!.sub };
  return sharedWhenUnowned ? { OR: [mine, { [field]: null }] } : mine;
}
