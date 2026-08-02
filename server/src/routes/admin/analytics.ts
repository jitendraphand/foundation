import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { findWeakAreas, type Breakdown, type Cell } from '../../lib/analytics.js';

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
        ...(q.division ? { division: q.division } : {}),
      },
      select: {
        id: true, username: true, firstName: true, lastName: true, grade: true, division: true,
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
      select: { id: true, username: true, firstName: true, lastName: true, grade: true, division: true, rollNo: true, isActive: true },
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

    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

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
      ].map(esc).join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="results-${new Date().toISOString().slice(0, 10)}.csv"`);
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
