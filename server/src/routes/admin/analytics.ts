import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ALL_AXES, findWeakAreas, type Breakdown, type Cell, type WeakArea } from '../../lib/analytics.js';
import { describeAudience, inAudience } from '../../lib/audience.js';
import { testsVisibleTo } from './tests.js';

/** One cell of a CSV, quoted only when it has to be. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const today = () => new Date().toISOString().slice(0, 10);

interface WeakStudent {
  student: { id: string; publicId: string; username: string; name: string; grade: string; division: string; rollNo: string };
  correct: number;
  total: number;
  accuracy: number;
  thin: boolean;
  papers: Array<{ testId: string; title: string; correct: number; total: number }>;
}

/** Which field of a breakdown each axis reads. */
const AXIS_FIELD: Record<WeakArea['axis'], keyof Breakdown> = {
  difficulty: 'byDifficulty',
  cognitive: 'byCognitive',
  skill: 'bySkill',
  topic: 'byTopic',
  subtopic: 'bySubtopic',
};

/**
 * Everything the admin's charts and tables are built from.
 *
 * REGULAR and PRACTICE data are kept apart at every level: the `kind` filter
 * defaults to REGULAR so practice attempts never quietly inflate class
 * performance figures.
 */

function mergeCells(target: Record<string, Cell>, source: Record<string, Cell> | undefined) {
  if (!source) return;
  for (const [key, cell] of Object.entries(source)) {
    const t = (target[key] ??= { correct: 0, total: 0, answered: 0, marks: 0, maxMarks: 0, accuracy: 0, avgTimeMs: 0 });
    t.correct += cell.correct;
    t.total += cell.total;
    t.answered += cell.answered;
    t.marks += cell.marks;
    t.maxMarks += cell.maxMarks;
  }
  for (const cell of Object.values(target)) {
    cell.accuracy = cell.total > 0 ? Math.round((cell.correct / cell.total) * 100) / 100 : 0;
  }
}

export default async function adminAnalyticsRoutes(app: FastifyInstance) {
  /** Headline numbers for the admin landing page. */
  app.get('/api/admin/analytics/overview', async (request) => {
    const q = z
      .object({
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        days: z.coerce.number().int().min(1).max(3650).default(90),
      })
      .parse(request.query);

    const since = new Date(Date.now() - q.days * 86_400_000);
    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const [totalStudents, activeStudents, totalTests, publishedTests, questionCounts, attempts] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null } }),
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null, isActive: true } }),
      prisma.test.count({ where: { deletedAt: null, ...kindFilter } }),
      prisma.test.count({ where: { deletedAt: null, status: 'PUBLISHED', ...kindFilter } }),
      prisma.question.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.attempt.findMany({
        where: {
          status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
          submittedAt: { gte: since },
          test: { ...kindFilter, deletedAt: null },
        },
        select: {
          percentage: true, submittedAt: true, breakdown: true,
          user: { select: { grade: true, division: true } },
          test: { select: { subject: true, kind: true } },
        },
      }),
    ]);

    const pcts = attempts.map((a) => a.percentage);
    const average = pcts.length ? Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 10) / 10 : 0;

    // Score distribution in ten-point bands, for the histogram.
    const distribution = Array.from({ length: 10 }, (_, i) => ({
      band: `${i * 10}-${i * 10 + 9}`,
      from: i * 10,
      count: 0,
    }));
    for (const p of pcts) {
      const idx = Math.min(9, Math.max(0, Math.floor(p / 10)));
      distribution[idx].count++;
    }

    // Attempts per day, for the trend line.
    const byDay = new Map<string, { date: string; attempts: number; totalPct: number }>();
    for (const a of attempts) {
      if (!a.submittedAt) continue;
      const key = a.submittedAt.toISOString().slice(0, 10);
      const row = byDay.get(key) ?? { date: key, attempts: 0, totalPct: 0 };
      row.attempts++;
      row.totalPct += a.percentage;
      byDay.set(key, row);
    }
    const trend = [...byDay.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ date: r.date, attempts: r.attempts, avgPercentage: Math.round((r.totalPct / r.attempts) * 10) / 10 }));

    // Class-by-class comparison.
    const byClass = new Map<string, { grade: string; division: string; attempts: number; totalPct: number }>();
    for (const a of attempts) {
      const key = `${a.user.grade}-${a.user.division}`;
      const row = byClass.get(key) ?? { grade: a.user.grade, division: a.user.division, attempts: 0, totalPct: 0 };
      row.attempts++;
      row.totalPct += a.percentage;
      byClass.set(key, row);
    }
    const classPerformance = [...byClass.values()]
      .map((r) => ({ ...r, avgPercentage: Math.round((r.totalPct / r.attempts) * 10) / 10 }))
      .sort((a, b) => b.avgPercentage - a.avgPercentage);

    // Subject-by-subject comparison.
    const bySubject = new Map<string, { subject: string; attempts: number; totalPct: number }>();
    for (const a of attempts) {
      const row = bySubject.get(a.test.subject) ?? { subject: a.test.subject, attempts: 0, totalPct: 0 };
      row.attempts++;
      row.totalPct += a.percentage;
      bySubject.set(a.test.subject, row);
    }
    const subjectPerformance = [...bySubject.values()]
      .map((r) => ({ ...r, avgPercentage: Math.round((r.totalPct / r.attempts) * 10) / 10 }))
      .sort((a, b) => b.avgPercentage - a.avgPercentage);

    // Cohort-wide tag mastery: which axes is the whole school weak on.
    const merged: Breakdown = { byDifficulty: {}, byCognitive: {}, bySkill: {}, byTopic: {}, bySubtopic: {} };
    for (const a of attempts) {
      const b = a.breakdown as unknown as Breakdown | null;
      if (!b) continue;
      mergeCells(merged.byDifficulty, b.byDifficulty);
      mergeCells(merged.byCognitive, b.byCognitive);
      mergeCells(merged.bySkill, b.bySkill);
      mergeCells(merged.byTopic, b.byTopic);
      mergeCells(merged.bySubtopic, b.bySubtopic);
    }

    const cohortWeakAreas = findWeakAreas([merged], { minSample: 10, accuracyThreshold: 0.65, limit: 10 });

    return {
      totals: {
        students: totalStudents,
        activeStudents,
        inactiveStudents: totalStudents - activeStudents,
        tests: totalTests,
        publishedTests,
        questions: {
          draft: questionCounts.find((c) => c.status === 'DRAFT')?._count._all ?? 0,
          approved: questionCounts.find((c) => c.status === 'APPROVED')?._count._all ?? 0,
          rejected: questionCounts.find((c) => c.status === 'REJECTED')?._count._all ?? 0,
        },
        attempts: attempts.length,
        averagePercentage: average,
      },
      distribution,
      trend,
      classPerformance,
      subjectPerformance,
      tagMastery: merged,
      cohortWeakAreas,
      filter: { kind: q.kind, days: q.days },
    };
  });

  /** Ranked student list, for spotting who needs help. */
  app.get('/api/admin/analytics/students', async (request) => {
    const q = z
      .object({
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        grade: z.string().optional(),
        division: z.string().optional(),
        minAttempts: z.coerce.number().int().min(0).default(1),
      })
      .parse(request.query);

    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const students = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        deletedAt: null,
        ...(q.grade ? { grade: q.grade } : {}),
        // Membership rather than the home division; see the User model.
        ...(q.division ? { divisions: { has: q.division } } : {}),
      },
      select: {
        id: true, publicId: true, username: true, firstName: true, lastName: true, grade: true, division: true,
        rollNo: true, isActive: true, lastLoginAt: true,
        attempts: {
          where: { status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] }, test: { ...kindFilter, deletedAt: null } },
          select: { percentage: true, submittedAt: true, breakdown: true },
          orderBy: { submittedAt: 'desc' },
        },
      },
    });

    const rows = students
      .filter((s) => s.attempts.length >= q.minAttempts)
      .map((s) => {
        const pcts = s.attempts.map((a) => a.percentage);
        const avg = pcts.length ? Math.round((pcts.reduce((x, y) => x + y, 0) / pcts.length) * 10) / 10 : 0;

        // Trend = mean of the newest three minus mean of the oldest three.
        const recent = pcts.slice(0, 3);
        const older = pcts.slice(-3);
        const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
        const trend = pcts.length >= 4 ? Math.round((mean(recent) - mean(older)) * 10) / 10 : 0;

        const weak = findWeakAreas(
          s.attempts.map((a) => a.breakdown as unknown as Breakdown).filter(Boolean),
          { minSample: 3, accuracyThreshold: 0.7, limit: 4 },
        );

        return {
          id: s.id,
          publicId: s.publicId,
          username: s.username,
          name: `${s.firstName} ${s.lastName}`,
          grade: s.grade,
          division: s.division,
          rollNo: s.rollNo,
          isActive: s.isActive,
          lastLoginAt: s.lastLoginAt,
          attempts: s.attempts.length,
          averagePercentage: avg,
          bestPercentage: pcts.length ? Math.max(...pcts) : 0,
          lastPercentage: pcts[0] ?? 0,
          trend,
          weakAreas: weak,
        };
      })
      .sort((a, b) => a.averagePercentage - b.averagePercentage);

    return { students: rows, filter: q };
  });

  /** One student's full profile, and the practice-test seed for them. */
  app.get('/api/admin/analytics/students/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const student = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, publicId: true, username: true, firstName: true, lastName: true, grade: true, division: true, rollNo: true, isActive: true },
    });
    if (!student) return reply.code(404).send({ error: 'Student not found.' });

    const attempts = await prisma.attempt.findMany({
      where: { userId: id, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true, percentage: true, score: true, maxScore: true, submittedAt: true, breakdown: true,
        correctCount: true, incorrectCount: true, unansweredCount: true,
        test: { select: { id: true, title: true, subject: true, kind: true } },
      },
    });

    const regular = attempts.filter((a) => a.test.kind === 'REGULAR');
    const practice = attempts.filter((a) => a.test.kind === 'PRACTICE');

    const merged: Breakdown = { byDifficulty: {}, byCognitive: {}, bySkill: {}, byTopic: {}, bySubtopic: {} };
    for (const a of regular) {
      const b = a.breakdown as unknown as Breakdown | null;
      if (!b) continue;
      mergeCells(merged.byDifficulty, b.byDifficulty);
      mergeCells(merged.byCognitive, b.byCognitive);
      mergeCells(merged.bySkill, b.bySkill);
      mergeCells(merged.byTopic, b.byTopic);
      mergeCells(merged.bySubtopic, b.bySubtopic);
    }

    const weakAreas = findWeakAreas([merged], { minSample: 3, accuracyThreshold: 0.7, limit: 12 });

    // Which subjects and topics to seed a practice test with.
    const suggestedFocus = {
      subjects: [...new Set(regular.map((a) => a.test.subject))],
      topics: weakAreas.filter((w) => w.axis === 'topic' || w.axis === 'subtopic').map((w) => w.key),
      skills: weakAreas.filter((w) => w.axis === 'skill').map((w) => w.key),
      cognitive: weakAreas.filter((w) => w.axis === 'cognitive').map((w) => w.key),
      difficulty: weakAreas.filter((w) => w.axis === 'difficulty').map((w) => w.key),
    };

    return {
      student,
      regular: regular.map(shape),
      practice: practice.map(shape),
      tagMastery: merged,
      weakAreas,
      suggestedFocus,
    };
  });

  /**
   * Who has not sat a paper - the question a teacher actually asks the morning
   * after, and the one the results table cannot answer.
   *
   * Everything here is built from the audience, not from the attempts. A list
   * of attempts tells you who turned up; only the audience minus the attempts
   * tells you who did not, and that is the list somebody has to act on.
   *
   * Several papers at once, because "who has fallen behind this term" is a
   * different question from "who missed Friday's test", and a teacher chasing
   * one child wants both answered in one place. Each student carries a row per
   * paper, so the answer is a grid rather than a count.
   */
  app.get('/api/admin/analytics/participation', async (request) => participation(request));

  /** The same report as a spreadsheet, for a teacher working from a printout. */
  app.get('/api/admin/analytics/participation.csv', async (request, reply) => {
    const report = await participation(request);
    const header = ['user_id', 'name', 'username', 'class', 'roll_no', 'set_for', 'sat', 'still_missing', 'missing_tests'];
    const byId = new Map(report.tests.map((t) => [t.id, t]));
    const lines = [header.join(',')];
    for (const row of report.students) {
      lines.push([
        row.student.publicId, row.student.name, row.student.username,
        `${row.student.grade}-${row.student.division}`, row.student.rollNo,
        row.setFor, row.sat, row.missing,
        row.missingTestIds.map((id) => byId.get(id)?.title ?? id).join('; '),
      ].map(csvCell).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="not-sat-${today()}.csv"`);
    return lines.join('\n');
  });

  async function participation(request: FastifyRequest) {
    const q = z
      .object({
        /** Explicit papers, comma-separated. Wins over the filters below. */
        testIds: z.string().optional(),
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        subject: z.string().max(120).optional(),
        /** Part of a paper's title, for finding one particular test. */
        search: z.string().max(200).optional(),
        grade: z.string().max(20).optional(),
        division: z.string().max(20).optional(),
        /** How far back to look for papers, when they are not named. */
        days: z.coerce.number().int().min(1).max(3650).default(90),
        /**
         * Drop everybody who is up to date. Applied here rather than on the
         * screen so the downloaded list is the list being looked at - a button
         * under a filtered table that hands back the unfiltered thing is how a
         * teacher ends up chasing children who did nothing wrong.
         */
        missingOnly: z
          .union([z.literal('true'), z.literal('false'), z.boolean()])
          .transform((v) => v === true || v === 'true')
          .default(false),
        /**
         * How many papers the grid may hold. A table forty columns wide is not
         * a report anybody reads, so the window is small and the search box is
         * how a teacher reaches one particular paper rather than the newest few.
         */
        max: z.coerce.number().int().min(1).max(40).default(12),
      })
      .parse(request.query);

    const ids = (q.testIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const tests = await prisma.test.findMany({
      where: {
        deletedAt: null,
        ...testsVisibleTo(request),
        ...(ids.length
          ? { id: { in: ids } }
          : {
              // Only a paper students could actually have sat. A draft nobody
              // can see is not a paper anybody has missed.
              status: { in: ['PUBLISHED', 'CLOSED'] },
              ...(q.kind === 'ALL' ? {} : { kind: q.kind }),
              ...(q.subject ? { subject: q.subject } : {}),
              ...(q.search ? { title: { contains: q.search, mode: 'insensitive' as const } } : {}),
              createdAt: { gte: new Date(Date.now() - q.days * 86_400_000) },
            }),
      },
      orderBy: { createdAt: 'desc' },
      take: q.max,
      select: {
        id: true, publicId: true, title: true, subject: true, kind: true, status: true,
        targetGrades: true, targetDivisions: true, targetUserId: true,
        createdAt: true, passPercentage: true,
      },
    });

    if (tests.length === 0) {
      return { tests: [], students: [], totals: { audience: 0, missing: 0, partial: 0, complete: 0 }, filter: q };
    }

    // One query for everybody who could be in any of these audiences, then the
    // per-paper membership is decided in memory - a student may be in one
    // paper's audience and not another's, and that cannot be a single query.
    const [students, attempts] = await Promise.all([
      prisma.user.findMany({
        where: {
          role: 'STUDENT',
          deletedAt: null,
          isActive: true,
          ...(q.grade ? { grade: q.grade } : {}),
          ...(q.division ? { divisions: { has: q.division } } : {}),
        },
        orderBy: [{ grade: 'asc' }, { division: 'asc' }, { rollNo: 'asc' }],
        select: {
          id: true, publicId: true, username: true, firstName: true, lastName: true,
          grade: true, division: true, divisions: true, rollNo: true, lastLoginAt: true,
        },
      }),
      prisma.attempt.findMany({
        where: { testId: { in: tests.map((t) => t.id) } },
        orderBy: { startedAt: 'asc' },
        select: { testId: true, userId: true, status: true, percentage: true, submittedAt: true },
      }),
    ]);

    // Best attempt per student per paper: a resit that was submitted beats an
    // abandoned first go, so nobody is reported as missing a paper they sat.
    const rank = { SUBMITTED: 3, AUTO_SUBMITTED: 3, IN_PROGRESS: 2, ABANDONED: 1 } as const;
    const best = new Map<string, (typeof attempts)[number]>();
    for (const a of attempts) {
      const key = `${a.testId}:${a.userId}`;
      const held = best.get(key);
      if (!held || rank[a.status] > rank[held.status] || (rank[a.status] === rank[held.status] && a.percentage > held.percentage)) {
        best.set(key, a);
      }
    }

    const totals = { audience: 0, missing: 0, partial: 0, complete: 0 };

    const rows = students
      .map((s) => {
        const cells = tests
          .filter((t) => inAudience(t, s))
          .map((t) => {
            const a = best.get(`${t.id}:${s.id}`);
            const state = !a
              ? 'not_started'
              : a.status === 'IN_PROGRESS'
                ? 'in_progress'
                : a.status === 'ABANDONED'
                  ? 'abandoned'
                  : 'submitted';
            return {
              testId: t.id,
              state,
              percentage: state === 'submitted' ? a!.percentage : null,
              submittedAt: a?.submittedAt ?? null,
              passed: state === 'submitted' ? a!.percentage >= t.passPercentage : null,
            };
          });

        const missed = cells.filter((c) => c.state !== 'submitted');
        return {
          student: {
            id: s.id, publicId: s.publicId, username: s.username,
            name: `${s.firstName} ${s.lastName}`,
            grade: s.grade, division: s.division, rollNo: s.rollNo, lastLoginAt: s.lastLoginAt,
          },
          setFor: cells.length,
          sat: cells.length - missed.length,
          missing: missed.length,
          missingTestIds: missed.map((c) => c.testId),
          cells,
        };
      })
      // A student none of these papers were set for is not part of this report.
      .filter((r) => r.setFor > 0);

    // Counted over everybody the papers were set for, whatever is then shown:
    // "4 of 6 have not sat it" needs the 6.
    for (const r of rows) {
      totals.audience++;
      if (r.missing === r.setFor) totals.missing++;
      else if (r.missing > 0) totals.partial++;
      else totals.complete++;
    }

    // Most still owing first: this list exists to be worked down.
    rows.sort((a, b) => b.missing - a.missing || a.student.name.localeCompare(b.student.name));

    const shown = q.missingOnly ? rows.filter((r) => r.missing > 0) : rows;

    return {
      tests: tests.map((t) => ({
        id: t.id, publicId: t.publicId, title: t.title, subject: t.subject, kind: t.kind,
        status: t.status, createdAt: t.createdAt, audience: describeAudience(t),
      })),
      students: shown,
      totals,
      filter: q,
    };
  }

  /**
   * Who is weak at one particular thing.
   *
   * The student table already shows each child's own worst areas, which answers
   * "how is this child doing". It cannot answer the other question a teacher
   * has - "who in this class needs another lesson on fractions" - because that
   * means holding one tag fixed and looking down the column instead of across
   * the row.
   *
   * Called without a tag it returns the column headings: every tag on the axis
   * with the cohort's accuracy and how many students are below the line, so the
   * worst skill in the school is visible before anybody picks anything.
   */
  app.get('/api/admin/analytics/weakness', async (request) => weakness(request));

  app.get('/api/admin/analytics/weakness.csv', async (request, reply) => {
    const report = await weakness(request);
    const header = ['user_id', 'name', 'username', 'class', 'roll_no', 'axis', 'tag', 'correct', 'answered', 'accuracy_pct', 'too_few_questions'];
    const lines = [header.join(',')];
    for (const row of report.students) {
      lines.push([
        row.student.publicId, row.student.name, row.student.username,
        `${row.student.grade}-${row.student.division}`, row.student.rollNo,
        report.axis, report.key ?? '', row.correct, row.total,
        Math.round(row.accuracy * 100), row.thin ? 'yes' : 'no',
      ].map(csvCell).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="weak-${report.key ?? report.axis}-${today()}.csv"`);
    return lines.join('\n');
  });

  async function weakness(request: FastifyRequest) {
    const q = z
      .object({
        axis: z.enum(ALL_AXES).default('skill'),
        /** The tag itself, e.g. "algebraic_manipulation". */
        key: z.string().max(120).optional(),
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        grade: z.string().max(20).optional(),
        division: z.string().max(20).optional(),
        /** Below this and a student counts as weak. 0..1. */
        threshold: z.coerce.number().min(0).max(1).default(0.6),
        /** Fewer answered questions than this and the number means nothing. */
        minQuestions: z.coerce.number().int().min(1).max(100).default(4),
        days: z.coerce.number().int().min(1).max(3650).default(365),
      })
      .parse(request.query);

    const field = AXIS_FIELD[q.axis];
    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const students = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        deletedAt: null,
        isActive: true,
        ...(q.grade ? { grade: q.grade } : {}),
        ...(q.division ? { divisions: { has: q.division } } : {}),
      },
      select: {
        id: true, publicId: true, username: true, firstName: true, lastName: true,
        grade: true, division: true, rollNo: true,
        attempts: {
          where: {
            status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
            submittedAt: { gte: new Date(Date.now() - q.days * 86_400_000) },
            test: { ...kindFilter, deletedAt: null },
          },
          select: { breakdown: true, submittedAt: true, test: { select: { id: true, title: true } } },
        },
      },
    });

    /** correct/total on one tag for one student, across their attempts. */
    const tally = (attempts: (typeof students)[number]['attempts'], key: string) => {
      let correct = 0;
      let total = 0;
      const papers: Array<{ testId: string; title: string; correct: number; total: number }> = [];
      for (const a of attempts) {
        const cell = ((a.breakdown as unknown as Breakdown | null)?.[field] ?? {})[key];
        if (!cell) continue;
        correct += cell.correct;
        total += cell.total;
        papers.push({ testId: a.test.id, title: a.test.title, correct: cell.correct, total: cell.total });
      }
      return { correct, total, papers };
    };

    // Every tag anybody has actually been examined on, with the cohort figure.
    const seen = new Map<string, { key: string; correct: number; total: number; students: number; weak: number }>();
    for (const s of students) {
      const keys = new Set<string>();
      for (const a of s.attempts) {
        for (const k of Object.keys(((a.breakdown as unknown as Breakdown | null)?.[field] ?? {}))) keys.add(k);
      }
      for (const k of keys) {
        const { correct, total } = tally(s.attempts, k);
        const row = seen.get(k) ?? { key: k, correct: 0, total: 0, students: 0, weak: 0 };
        row.correct += correct;
        row.total += total;
        row.students++;
        if (total >= q.minQuestions && correct / total < q.threshold) row.weak++;
        seen.set(k, row);
      }
    }

    const tags = [...seen.values()]
      .map((t) => ({ ...t, accuracy: t.total ? Math.round((t.correct / t.total) * 100) / 100 : 0 }))
      .sort((a, b) => b.weak - a.weak || a.accuracy - b.accuracy);

    if (!q.key) return { axis: q.axis, key: null as string | null, tags, students: [] as WeakStudent[], filter: q };

    const rows = students
      .map((s) => {
        const { correct, total, papers } = tally(s.attempts, q.key!);
        return {
          student: {
            id: s.id, publicId: s.publicId, username: s.username,
            name: `${s.firstName} ${s.lastName}`,
            grade: s.grade, division: s.division, rollNo: s.rollNo,
          },
          correct,
          total,
          accuracy: total ? Math.round((correct / total) * 100) / 100 : 0,
          /** Too few questions to say anything - reported, never counted. */
          thin: total < q.minQuestions,
          papers,
        };
      })
      .filter((r) => r.total > 0 && (r.thin || r.accuracy < q.threshold))
      .sort((a, b) => Number(a.thin) - Number(b.thin) || a.accuracy - b.accuracy || b.total - a.total);

    return { axis: q.axis, key: q.key, tags, students: rows, filter: q };
  }

  /** CSV export of all results, for a spreadsheet. */
  app.get('/api/admin/analytics/export.csv', async (request, reply) => {
    const q = z.object({ kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('ALL') }).parse(request.query);
    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const attempts = await prisma.attempt.findMany({
      where: { status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] }, test: { ...kindFilter } },
      orderBy: { submittedAt: 'desc' },
      select: {
        score: true, maxScore: true, percentage: true, submittedAt: true, startedAt: true,
        correctCount: true, incorrectCount: true, unansweredCount: true, status: true,
        user: { select: { username: true, firstName: true, lastName: true, grade: true, division: true, rollNo: true } },
        test: { select: { title: true, subject: true, kind: true } },
      },
    });

    const header = [
      'username', 'first_name', 'last_name', 'grade', 'division', 'roll_no',
      'test_title', 'subject', 'test_kind', 'score', 'max_score', 'percentage',
      'correct', 'incorrect', 'unanswered', 'status', 'started_at', 'submitted_at',
    ];

    const lines = [header.join(',')];
    for (const a of attempts) {
      lines.push([
        a.user.username, a.user.firstName, a.user.lastName, a.user.grade, a.user.division, a.user.rollNo,
        a.test.title, a.test.subject, a.test.kind, a.score, a.maxScore, a.percentage,
        a.correctCount, a.incorrectCount, a.unansweredCount, a.status,
        a.startedAt.toISOString(), a.submittedAt?.toISOString() ?? '',
      ].map(csvCell).join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="results-${today()}.csv"`);
    return lines.join('\n');
  });
}

function shape(a: {
  id: string;
  percentage: number;
  score: number;
  maxScore: number;
  submittedAt: Date | null;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  test: { id: string; title: string; subject: string; kind: string };
}) {
  return {
    attemptId: a.id,
    testId: a.test.id,
    title: a.test.title,
    subject: a.test.subject,
    kind: a.test.kind,
    score: a.score,
    maxScore: a.maxScore,
    percentage: a.percentage,
    correctCount: a.correctCount,
    incorrectCount: a.incorrectCount,
    unansweredCount: a.unansweredCount,
    submittedAt: a.submittedAt,
  };
}
