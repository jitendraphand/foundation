import { prisma } from '../db.js';
import type { Activity } from '@prisma/client';

/**
 * Which activities is this student still required to do?
 *
 * An activity blocks when all of these hold:
 *   - it is PUBLISHED and marked mandatory
 *   - now is inside its startsAt/endsAt, if either is set
 *   - it is aimed at this student, by class or by name
 *   - they have not completed it
 *
 * Ordered oldest first, so a student who owes several works through them in
 * the order they were set rather than the order the database happened to
 * return.
 */

export interface PendingActivity {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  kind: Activity['kind'];
}

export async function pendingActivitiesFor(userId: string): Promise<PendingActivity[]> {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { grade: true, division: true, role: true },
  });

  // Administrators are not held at the door by their own homework.
  if (!me || me.role !== 'STUDENT') return [];

  const now = new Date();

  const activities = await prisma.activity.findMany({
    where: {
      status: 'PUBLISHED',
      isMandatory: true,
      deletedAt: null,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        {
          OR: [
            {
              targetUserId: null,
              AND: [
                { OR: [{ targetGrades: { isEmpty: true } }, { targetGrades: { has: me.grade } }] },
                { OR: [{ targetDivisions: { isEmpty: true } }, { targetDivisions: { has: me.division } }] },
              ],
            },
            { targetUserId: userId },
          ],
        },
      ],
      // Not yet finished by this student.
      completions: { none: { userId, completedAt: { not: null } } },
    },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true, publicId: true, title: true, description: true, kind: true },
  });

  return activities;
}

/** Cheap check for the request hook: is anything outstanding? */
export async function hasPendingActivity(userId: string): Promise<PendingActivity | null> {
  const pending = await pendingActivitiesFor(userId);
  return pending[0] ?? null;
}

/**
 * May this student open this particular activity?
 *
 * Same audience rules as above, but without the mandatory and completion
 * filters, so an optional activity - or one they have already done - can still
 * be revisited.
 */
export async function activityVisibleTo(activityId: string, userId: string): Promise<Activity | null> {
  const [me, activity] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { grade: true, division: true } }),
    prisma.activity.findFirst({ where: { id: activityId, deletedAt: null, status: 'PUBLISHED' } }),
  ]);

  if (!me || !activity) return null;

  const now = new Date();
  if (activity.startsAt && activity.startsAt > now) return null;
  if (activity.endsAt && activity.endsAt < now) return null;

  if (activity.targetUserId) {
    return activity.targetUserId === userId ? activity : null;
  }

  const gradeOk = activity.targetGrades.length === 0 || activity.targetGrades.includes(me.grade);
  const divisionOk = activity.targetDivisions.length === 0 || activity.targetDivisions.includes(me.division);
  return gradeOk && divisionOk ? activity : null;
}

/** How many cards an activity holds, for progress and completion checks. */
export function cardCount(activity: Pick<Activity, 'content'>): number {
  const content = activity.content as { cards?: unknown[] } | null;
  return Array.isArray(content?.cards) ? content!.cards!.length : 0;
}
