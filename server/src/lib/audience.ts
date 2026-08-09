import type { Prisma } from '@prisma/client';

/**
 * Who a test or an activity is actually for.
 *
 * Three rules, and all three matter for "who has not done this yet" - a roster
 * built on the wrong audience either accuses children of missing a paper that
 * was never set for them, or quietly leaves out the ones who did miss it.
 *
 *  1. An empty target list means everybody. That is what makes a school-wide
 *     notice possible without a join table.
 *  2. Divisions are a membership, not the home division. A child in the Science
 *     Foundation as well as 8-A must appear in the Science Foundation's roster.
 *  3. A practice paper aimed at one student has an audience of exactly that
 *     student, whatever the grade and division lists say.
 *
 * Deactivated and deleted accounts are excluded: a child who has left the
 * school has not "missed" this week's test, and a list that says they have is
 * a list a teacher stops trusting.
 */
export interface Targeted {
  targetGrades: string[];
  targetDivisions: string[];
  targetUserId?: string | null;
}

export function audienceWhere(target: Targeted): Prisma.UserWhereInput {
  if (target.targetUserId) return { id: target.targetUserId };

  return {
    role: 'STUDENT',
    isActive: true,
    deletedAt: null,
    ...(target.targetGrades.length ? { grade: { in: target.targetGrades } } : {}),
    ...(target.targetDivisions.length ? { divisions: { hasSome: target.targetDivisions } } : {}),
  };
}

/** Whether one student is in the audience, given rows already in memory. */
export function inAudience(
  target: Targeted,
  student: { id: string; grade: string; divisions: string[] },
): boolean {
  if (target.targetUserId) return student.id === target.targetUserId;
  const gradeOk = target.targetGrades.length === 0 || target.targetGrades.includes(student.grade);
  const divisionOk =
    target.targetDivisions.length === 0 || target.targetDivisions.some((d) => student.divisions.includes(d));
  return gradeOk && divisionOk;
}

/** How the audience reads on screen: "Grade 8 · Science Foundation", "Everyone". */
export function describeAudience(target: Targeted): string {
  if (target.targetUserId) return 'One student';
  const parts = [
    target.targetGrades.length ? target.targetGrades.join(', ') : '',
    target.targetDivisions.length ? target.targetDivisions.join(', ') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone';
}
