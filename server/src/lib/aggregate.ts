import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { Breakdown, Cell, WeakArea } from './analytics.js';

/**
 * The analytics figures, computed by the database rather than by Node.
 *
 * The screens used to work by loading every matching Attempt row - each one
 * carrying a `breakdown` JSON of every tag the student was examined on - and
 * folding them together in JavaScript. One academic year of a two-division
 * school is around 8,700 attempts, and that came to 2.9 seconds and 20 MB of
 * objects per request, for a reply of 5 KB. Three years in it is three times
 * that, and it grows for as long as the school keeps using the system.
 *
 * The cost that actually mattered was not the wait. The API is one Node
 * process, so those 2.9 seconds are 2.9 seconds during which no student's
 * autosave is answered - a teacher opening the analytics tab mid-exam stalled
 * the exam. Aggregating in SQL turned that into 40-240 ms of database time
 * during which Node is free.
 *
 * Everything here is parameterised through Prisma.sql. No caller-supplied
 * string is ever concatenated into a statement; the axis name picks a field
 * from a fixed map, and every value is a bind parameter.
 */

export interface AttemptFilter {
  kind: 'REGULAR' | 'PRACTICE' | 'ALL';
  since?: Date;
  grade?: string;
  division?: string;
  /** Restrict to one student, for their own profile. */
  userId?: string;
  /**
   * Only papers whose results the student is allowed to see. The same rule as
   * resultsAreVisible(): practice is always immediate, everything else waits
   * for the teacher to release it. Set on anything a student can read, so an
   * unreleased mark cannot leak through a weak-areas summary.
   */
  releasedOnly?: boolean;
}

/** The WHERE shared by every query below, as bind parameters. */
function conditions(f: AttemptFilter): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [
    Prisma.sql`a."status" IN ('SUBMITTED', 'AUTO_SUBMITTED')`,
    Prisma.sql`t."deletedAt" IS NULL`,
    Prisma.sql`u."deletedAt" IS NULL`,
  ];
  if (f.kind !== 'ALL') parts.push(Prisma.sql`t."kind"::text = ${f.kind}`);
  if (f.since) parts.push(Prisma.sql`a."submittedAt" >= ${f.since}`);
  if (f.grade) parts.push(Prisma.sql`u."grade" = ${f.grade}`);
  if (f.division) parts.push(Prisma.sql`${f.division} = ANY(u."divisions")`);
  if (f.userId) parts.push(Prisma.sql`a."userId" = ${f.userId}`);
  if (f.releasedOnly) parts.push(Prisma.sql`(t."kind"::text = 'PRACTICE' OR t."resultsReleased")`);
  return parts;
}

const where = (f: AttemptFilter) => Prisma.join(conditions(f), ' AND ');

const FROM = Prisma.sql`
  FROM "Attempt" a
  JOIN "Test" t ON t."id" = a."testId"
  JOIN "User" u ON u."id" = a."userId"`;

/** Which field of a breakdown each axis reads. */
export const AXIS_FIELD: Record<WeakArea['axis'], keyof Breakdown> = {
  difficulty: 'byDifficulty',
  cognitive: 'byCognitive',
  skill: 'bySkill',
  topic: 'byTopic',
  subtopic: 'bySubtopic',
};

const AXES = Object.entries(AXIS_FIELD) as Array<[WeakArea['axis'], keyof Breakdown]>;

// --- headline numbers --------------------------------------------------------

export interface Headline {
  attempts: number;
  students: number;
  average: number;
  median: number;
  passRate: number;
  distribution: Array<{ band: string; from: number; count: number }>;
}

export async function headline(f: AttemptFilter): Promise<Headline> {
  const [row] = await prisma.$queryRaw<Array<{
    n: number; avg: number | null; median: number | null; passed: number;
  }>>`
    SELECT count(*)::int                                              AS n,
           avg(a."percentage")                                        AS avg,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a."percentage") AS median,
           count(*) FILTER (WHERE a."percentage" >= t."passPercentage")::int AS passed
    ${FROM}
    WHERE ${where(f)}`;

  const [people] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT a."userId")::int AS n ${FROM} WHERE ${where(f)}`;

  // Ten-point bands for the histogram, counted by the database.
  const bands = await prisma.$queryRaw<Array<{ band: number; n: number }>>`
    SELECT least(9, greatest(0, floor(a."percentage" / 10)))::int AS band, count(*)::int AS n
    ${FROM} WHERE ${where(f)}
    GROUP BY 1 ORDER BY 1`;

  const byBand = new Map(bands.map((b) => [b.band, b.n]));
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    band: `${i * 10}-${i * 10 + 9}`,
    from: i * 10,
    count: byBand.get(i) ?? 0,
  }));

  const n = row?.n ?? 0;
  return {
    attempts: n,
    students: people?.n ?? 0,
    average: round1(row?.avg ?? 0),
    median: round1(row?.median ?? 0),
    passRate: n > 0 ? round1(((row?.passed ?? 0) / n) * 100) : 0,
    distribution,
  };
}

// --- trends and comparisons --------------------------------------------------

export async function trendByDay(f: AttemptFilter) {
  const rows = await prisma.$queryRaw<Array<{ day: Date; n: number; avg: number }>>`
    SELECT date_trunc('day', a."submittedAt") AS day, count(*)::int AS n, avg(a."percentage") AS avg
    ${FROM} WHERE ${where(f)} AND a."submittedAt" IS NOT NULL
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    attempts: r.n,
    avgPercentage: round1(r.avg),
  }));
}

export async function byClass(f: AttemptFilter) {
  const rows = await prisma.$queryRaw<Array<{ grade: string; division: string; n: number; avg: number; students: number }>>`
    SELECT u."grade" AS grade, u."division" AS division,
           count(*)::int AS n, avg(a."percentage") AS avg,
           count(DISTINCT a."userId")::int AS students
    ${FROM} WHERE ${where(f)}
    GROUP BY 1, 2 ORDER BY avg DESC`;
  return rows.map((r) => ({
    grade: r.grade, division: r.division,
    attempts: r.n, students: r.students, avgPercentage: round1(r.avg),
  }));
}

export async function bySubject(f: AttemptFilter) {
  const rows = await prisma.$queryRaw<Array<{ subject: string; n: number; avg: number }>>`
    SELECT t."subject" AS subject, count(*)::int AS n, avg(a."percentage") AS avg
    ${FROM} WHERE ${where(f)}
    GROUP BY 1 ORDER BY avg DESC`;
  return rows.map((r) => ({ subject: r.subject, attempts: r.n, avgPercentage: round1(r.avg) }));
}

// --- tag mastery -------------------------------------------------------------

/**
 * correct/total for every tag on every axis, in one pass over the breakdowns.
 *
 * `jsonb_each` unnests the per-axis object into rows, so the database does the
 * folding that used to happen in JavaScript. The VALUES list naming the axes is
 * built from the fixed map above, never from a request.
 */
export async function tagTallies(
  f: AttemptFilter,
  axes: ReadonlyArray<WeakArea['axis']> = ['difficulty', 'cognitive', 'skill'],
): Promise<Breakdown> {
  const wanted = AXES.filter(([axis]) => axes.includes(axis));
  if (wanted.length === 0) return emptyBreakdown();

  const axisValues = Prisma.join(
    wanted.map(([axis, field]) => Prisma.sql`(${axis}, ${field})`),
  );

  const rows = await prisma.$queryRaw<Array<{
    axis: string; tag: string; correct: number; total: number; marks: number; max_marks: number;
  }>>`
    SELECT ax.name AS axis, e.key AS tag,
           SUM((e.value->>'correct')::int)                 AS correct,
           SUM((e.value->>'total')::int)                   AS total,
           SUM(COALESCE((e.value->>'marks')::float, 0))    AS marks,
           SUM(COALESCE((e.value->>'maxMarks')::float, 0)) AS max_marks
    ${FROM}
    CROSS JOIN LATERAL (VALUES ${axisValues}) AS ax(name, field)
    CROSS JOIN LATERAL jsonb_each(a."breakdown" -> ax.field) AS e
    WHERE ${where(f)}
    GROUP BY 1, 2`;

  const out = emptyBreakdown();
  for (const r of rows) {
    const field = AXIS_FIELD[r.axis as WeakArea['axis']];
    out[field][r.tag] = cell(Number(r.correct), Number(r.total), Number(r.marks), Number(r.max_marks));
  }
  return out;
}

// --- the ranked student table ------------------------------------------------

export interface StudentRow {
  id: string;
  publicId: string;
  username: string;
  name: string;
  grade: string;
  division: string;
  rollNo: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  attempts: number;
  averagePercentage: number;
  bestPercentage: number;
  lastPercentage: number;
  /** Newest three minus oldest three, in points. */
  trend: number;
}

export async function studentRows(f: AttemptFilter, minAttempts: number): Promise<StudentRow[]> {
  return prisma.$queryRaw<StudentRow[]>`
    WITH sat AS (
      SELECT a."userId"      AS uid,
             a."percentage"  AS pct,
             row_number() OVER (PARTITION BY a."userId" ORDER BY a."submittedAt" DESC) AS newest,
             row_number() OVER (PARTITION BY a."userId" ORDER BY a."submittedAt" ASC)  AS oldest
      ${FROM}
      WHERE ${where(f)}
    ),
    agg AS (
      SELECT uid,
             count(*)::int                                      AS attempts,
             avg(pct)                                           AS average,
             max(pct)                                           AS best,
             max(pct) FILTER (WHERE newest = 1)                 AS last,
             avg(pct) FILTER (WHERE newest <= 3)                 AS recent3,
             avg(pct) FILTER (WHERE oldest <= 3)                 AS oldest3
      FROM sat GROUP BY uid
    )
    SELECT u."id"          AS id,
           u."publicId"    AS "publicId",
           u."username"    AS username,
           u."firstName" || ' ' || u."lastName" AS name,
           u."grade"       AS grade,
           u."division"    AS division,
           u."rollNo"      AS "rollNo",
           u."isActive"    AS "isActive",
           u."lastLoginAt" AS "lastLoginAt",
           agg.attempts    AS attempts,
           round(agg.average::numeric, 1)::float AS "averagePercentage",
           round(agg.best::numeric, 1)::float    AS "bestPercentage",
           round(agg.last::numeric, 1)::float    AS "lastPercentage",
           CASE WHEN agg.attempts >= 4
                THEN round((agg.recent3 - agg.oldest3)::numeric, 1)::float
                ELSE 0 END                       AS trend
    FROM agg JOIN "User" u ON u."id" = agg.uid
    WHERE agg.attempts >= ${minAttempts}
    ORDER BY agg.average ASC`;
}

/**
 * Every student's correct/total on one tag, without loading a single breakdown
 * into Node. This is what makes "who in Grade 8 is weak at fractions" a
 * question the database answers.
 */
export interface TagStudent {
  id: string;
  publicId: string;
  username: string;
  name: string;
  grade: string;
  division: string;
  rollNo: string;
  correct: number;
  total: number;
  papers: number;
}

export async function studentsOnTag(f: AttemptFilter, axis: WeakArea['axis'], key: string): Promise<TagStudent[]> {
  const field = AXIS_FIELD[axis];
  const rows = await prisma.$queryRaw<Array<TagStudent & { correct: bigint | number; total: bigint | number; papers: number }>>`
    SELECT u."id"       AS id,
           u."publicId" AS "publicId",
           u."username" AS username,
           u."firstName" || ' ' || u."lastName" AS name,
           u."grade"    AS grade,
           u."division" AS division,
           u."rollNo"   AS "rollNo",
           SUM(((a."breakdown" -> ${field} -> ${key}) ->> 'correct')::int) AS correct,
           SUM(((a."breakdown" -> ${field} -> ${key}) ->> 'total')::int)   AS total,
           count(*)::int AS papers
    ${FROM}
    WHERE ${where(f)} AND a."breakdown" -> ${field} ? ${key}
    GROUP BY 1, 2, 3, 4, 5, 6, 7`;

  return rows.map((r) => ({ ...r, correct: Number(r.correct), total: Number(r.total) }));
}

/**
 * Every student's tally on every tag of every axis, in one query.
 *
 * This is what makes "62% average, weakest at fractions and ratios" affordable
 * on a table of 240 children: the alternative is a query per tag, or the whole
 * breakdown corpus in memory.
 */
export interface StudentTagTally {
  userId: string;
  axis: WeakArea['axis'];
  key: string;
  correct: number;
  total: number;
}

export async function studentTagTallies(
  f: AttemptFilter,
  axes: ReadonlyArray<WeakArea['axis']> = ['difficulty', 'cognitive', 'skill'],
): Promise<StudentTagTally[]> {
  const wanted = AXES.filter(([axis]) => axes.includes(axis));
  if (wanted.length === 0) return [];

  const axisValues = Prisma.join(wanted.map(([axis, field]) => Prisma.sql`(${axis}, ${field})`));

  const rows = await prisma.$queryRaw<Array<{
    user_id: string; axis: string; key: string; correct: bigint; total: bigint;
  }>>`
    SELECT a."userId" AS user_id, ax.name AS axis, e.key AS key,
           SUM((e.value->>'correct')::int) AS correct,
           SUM((e.value->>'total')::int)   AS total
    ${FROM}
    CROSS JOIN LATERAL (VALUES ${axisValues}) AS ax(name, field)
    CROSS JOIN LATERAL jsonb_each(a."breakdown" -> ax.field) AS e
    WHERE ${where(f)}
    GROUP BY 1, 2, 3`;

  return rows.map((r) => ({
    userId: r.user_id,
    axis: r.axis as WeakArea['axis'],
    key: r.key,
    correct: Number(r.correct),
    total: Number(r.total),
  }));
}

/** Which papers each student met one tag on, and how they did on each. */
export async function paperTallies(f: AttemptFilter, axis: WeakArea['axis'], key: string) {
  const field = AXIS_FIELD[axis];
  const rows = await prisma.$queryRaw<Array<{
    user_id: string; test_id: string; title: string; correct: number; total: number;
  }>>`
    SELECT a."userId" AS user_id, t."id" AS test_id, t."title" AS title,
           ((a."breakdown" -> ${field} -> ${key}) ->> 'correct')::int AS correct,
           ((a."breakdown" -> ${field} -> ${key}) ->> 'total')::int   AS total
    ${FROM}
    WHERE ${where(f)} AND a."breakdown" -> ${field} ? ${key}
    ORDER BY a."submittedAt" ASC`;

  return rows.map((r) => ({
    userId: r.user_id,
    testId: r.test_id,
    title: r.title,
    correct: r.correct,
    total: r.total,
  }));
}

/** How many students are below the line on each tag, for the tag picker. */
export interface TagSummary {
  key: string;
  correct: number;
  total: number;
  accuracy: number;
  students: number;
  weak: number;
}

export async function tagSummaries(
  f: AttemptFilter,
  axis: WeakArea['axis'],
  threshold: number,
  minQuestions: number,
): Promise<TagSummary[]> {
  const field = AXIS_FIELD[axis];
  const rows = await prisma.$queryRaw<Array<{
    key: string; correct: bigint; total: bigint; students: number; weak: number;
  }>>`
    WITH per_student AS (
      SELECT e.key AS key, a."userId" AS uid,
             SUM((e.value->>'correct')::int) AS correct,
             SUM((e.value->>'total')::int)   AS total
      ${FROM}
      CROSS JOIN LATERAL jsonb_each(a."breakdown" -> ${field}) AS e
      WHERE ${where(f)}
      GROUP BY 1, 2
    )
    -- The threshold is applied to the exact ratio, matching the student list
    -- this count sits above. Rounding the accuracy first would let the header
    -- say "12 below the line" and the table underneath show 14.
    SELECT key,
           SUM(correct)          AS correct,
           SUM(total)            AS total,
           count(*)::int         AS students,
           count(*) FILTER (WHERE total >= ${minQuestions}
                              AND correct::float / total < ${threshold})::int AS weak
    FROM per_student
    GROUP BY key`;

  return rows
    .map((r) => {
      const correct = Number(r.correct);
      const total = Number(r.total);
      return {
        key: r.key,
        correct,
        total,
        accuracy: total > 0 ? Math.round((correct / total) * 100) / 100 : 0,
        students: r.students,
        weak: r.weak,
      };
    })
    .sort((a, b) => b.weak - a.weak || a.accuracy - b.accuracy);
}

/** Per-question difficulty, for spotting a question nobody could answer. */
export interface HardQuestion {
  id: string;
  subject: string;
  difficultyTag: string;
  served: number;
  correct: number;
  accuracy: number;
  preview: string;
}

export async function hardestQuestions(f: AttemptFilter, limit: number): Promise<HardQuestion[]> {
  const rows = await prisma.$queryRaw<Array<{
    id: string; subject: string; difficultyTag: string;
    served: bigint; correct: bigint; content: unknown;
  }>>`
    SELECT q."id" AS id, q."subject" AS subject, q."difficultyTag" AS "difficultyTag",
           count(*) AS served,
           count(*) FILTER (WHERE ans."isCorrect") AS correct,
           q."content" AS content
    FROM "Answer" ans
    JOIN "Attempt" a ON a."id" = ans."attemptId"
    JOIN "Test" t    ON t."id" = a."testId"
    JOIN "User" u    ON u."id" = a."userId"
    JOIN "Question" q ON q."id" = ans."questionId"
    WHERE ${where(f)} AND ans."response" IS NOT NULL AND q."deletedAt" IS NULL
    GROUP BY q."id", q."subject", q."difficultyTag", q."content"
    HAVING count(*) >= 10
    ORDER BY (count(*) FILTER (WHERE ans."isCorrect"))::float / count(*) ASC
    LIMIT ${limit}`;

  return rows.map((r) => {
    const served = Number(r.served);
    const correct = Number(r.correct);
    return {
      id: r.id,
      subject: r.subject,
      difficultyTag: r.difficultyTag,
      served,
      correct,
      accuracy: served > 0 ? Math.round((correct / served) * 100) / 100 : 0,
      preview: previewOf(r.content),
    };
  });
}

// --- helpers -----------------------------------------------------------------

function round1(n: number | null): number {
  return Math.round((n ?? 0) * 10) / 10;
}

function cell(correct: number, total: number, marks: number, maxMarks: number): Cell {
  return {
    correct,
    total,
    answered: total,
    marks: Math.round(marks * 100) / 100,
    maxMarks: Math.round(maxMarks * 100) / 100,
    accuracy: total > 0 ? Math.round((correct / total) * 100) / 100 : 0,
    avgTimeMs: 0,
  };
}

function emptyBreakdown(): Breakdown {
  return { byDifficulty: {}, byCognitive: {}, bySkill: {}, byTopic: {}, bySubtopic: {} };
}

/** First line of a question, for a table that has to say which question it is. */
function previewOf(content: unknown): string {
  const blocks = (content as { blocks?: Array<{ type: string; value?: string; tex?: string }> })?.blocks ?? [];
  const text = blocks
    .map((b) => (b.type === 'text' ? b.value : b.type === 'math' ? b.tex : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
