import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ALL_AXES, findWeakAreas, type Breakdown, type WeakArea } from '../../lib/analytics.js';
import { describeAudience, inAudience } from '../../lib/audience.js';
import { testsVisibleTo } from './tests.js';
import { csvCell } from '../../lib/csv.js';
import {
  AXIS_FIELD,
  byClass,
  bySubject,
  hardestQuestions,
  headline,
  paperTallies,
  studentRows,
  studentTagTallies,
  studentsOnTag,
  tagSummaries,
  tagTallies,
  trendByDay,
  type AttemptFilter,
} from '../../lib/aggregate.js';

const today = () => new Date().toISOString().slice(0, 10);

/** One thing worth a teacher's attention, in words rather than in axes. */
interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  /** The whole point, in one sentence, with the number in it. */
  headline: string;
  /** The evidence, and what it usually means. */
  detail: string;
  action: { label: string; to: string };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "fraction_operations" reads as "fraction operations" in a sentence. */
const humanTag = (key: string) => key.replace(/_/g, ' ');

interface WeakStudent {
  student: { id: string; publicId: string; username: string; name: string; grade: string; division: string; rollNo: string };
  correct: number;
  total: number;
  accuracy: number;
  thin: boolean;
  papers: Array<{ testId: string; title: string; correct: number; total: number }>;
}

/**
 * Everything the admin's charts and tables are built from.
 *
 * REGULAR and PRACTICE data are kept apart at every level: the `kind` filter
 * defaults to REGULAR so practice attempts never quietly inflate class
 * performance figures.
 *
 * The counting itself lives in lib/aggregate.ts and happens in the database.
 * See the note there for why: folding every attempt's breakdown in JavaScript
 * cost seconds of blocked event loop, and the API is one process, so those
 * seconds were taken from the students sitting a paper at the time.
 */

export default async function adminAnalyticsRoutes(app: FastifyInstance) {
  /** Headline numbers for the admin landing page. */
  app.get('/api/admin/analytics/overview', async (request) => {
    const q = z
      .object({
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        days: z.coerce.number().int().min(1).max(3650).default(90),
        grade: z.string().max(20).optional(),
        division: z.string().max(20).optional(),
      })
      .parse(request.query);

    const filter: AttemptFilter = {
      kind: q.kind,
      since: new Date(Date.now() - q.days * 86_400_000),
      grade: q.grade,
      division: q.division,
    };
    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const [
      totalStudents, activeStudents, totalTests, publishedTests, questionCounts,
      stats, trend, classPerformance, subjectPerformance, tagMastery, hardest,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null } }),
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null, isActive: true } }),
      prisma.test.count({ where: { deletedAt: null, ...kindFilter } }),
      prisma.test.count({ where: { deletedAt: null, status: 'PUBLISHED', ...kindFilter } }),
      prisma.question.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      headline(filter),
      trendByDay(filter),
      byClass(filter),
      bySubject(filter),
      tagTallies(filter),
      hardestQuestions(filter, 8),
    ]);

    const cohortWeakAreas = findWeakAreas([tagMastery], { minSample: 10, accuracyThreshold: 0.65, limit: 10 });

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
        attempts: stats.attempts,
        // How many children are actually behind these figures. An average over
        // 8,000 attempts means something different if it is 40 students or 240.
        studentsSat: stats.students,
        averagePercentage: stats.average,
        medianPercentage: stats.median,
        passRate: stats.passRate,
      },
      distribution: stats.distribution,
      trend,
      classPerformance,
      subjectPerformance,
      tagMastery,
      cohortWeakAreas,
      /** Questions almost nobody could answer - usually a wording problem. */
      hardestQuestions: hardest,
      filter: { kind: q.kind, days: q.days, grade: q.grade ?? null, division: q.division ?? null },
    };
  });

  /**
   * What needs a teacher's attention, in sentences.
   *
   * The charts below this on the screen are evidence; they are not an answer.
   * A histogram of score bands and a mastery grid both require the reader to
   * do the interpreting, every time they look, and the interpreting is the
   * part a computer can do: which child, which topic, which paper, and how
   * many. So this endpoint does it, and the screen leads with the result.
   *
   * Each finding names a number, says what it means, and links to the screen
   * where something can be done about it. Nothing is invented - every item is
   * a query the reports already supported, asked without being asked.
   */
  app.get('/api/admin/analytics/briefing', async (request) => {
    const q = z
      .object({
        kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('REGULAR'),
        days: z.coerce.number().int().min(1).max(3650).default(90),
        grade: z.string().max(20).optional(),
        division: z.string().max(20).optional(),
      })
      .parse(request.query);

    const filter: AttemptFilter = {
      kind: q.kind,
      since: new Date(Date.now() - q.days * 86_400_000),
      grade: q.grade,
      division: q.division,
    };

    const [stats, classes, skills, hardest, ranked, drafts, unreleased] = await Promise.all([
      headline(filter),
      byClass(filter),
      tagSummaries(filter, 'skill', 0.6, 4),
      hardestQuestions(filter, 5),
      studentRows(filter, 1),
      prisma.question.count({ where: { deletedAt: null, status: 'DRAFT' } }),
      // Papers everybody has finished whose marks are still hidden. Nowhere
      // else says this, and it is the one item on the list where children are
      // actually waiting on somebody.
      prisma.test.findMany({
        where: {
          deletedAt: null, status: { in: ['PUBLISHED', 'CLOSED'] },
          kind: 'REGULAR', resultsReleased: false,
          ...testsVisibleTo(request),
          attempts: { some: { status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } } },
        },
        select: {
          id: true, title: true,
          _count: { select: { attempts: { where: { status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const findings: Finding[] = [];

    if (stats.attempts === 0) {
      return { findings, totals: stats, filter: q };
    }

    // Children who are behind. The pass mark is per paper, so "below 40%
    // average" is the plainest cohort-wide line to draw.
    const behind = ranked.filter((s) => s.averagePercentage < 40);
    if (behind.length > 0) {
      findings.push({
        id: 'students-behind',
        severity: 'high',
        headline: `${behind.length} ${plural(behind.length, 'student is', 'students are')} averaging under 40%`,
        detail: behind.slice(0, 4).map((s) => `${s.name} (${s.averagePercentage}%)`).join(', ')
          + (behind.length > 4 ? `, and ${behind.length - 4} more` : ''),
        action: { label: 'See the ranked list', to: '/admin/students' },
      });
    }

    // Children who are slipping, which a average alone hides completely.
    const slipping = ranked.filter((s) => s.trend <= -10).sort((a, b) => a.trend - b.trend);
    if (slipping.length > 0) {
      findings.push({
        id: 'students-slipping',
        severity: 'high',
        headline: `${slipping.length} ${plural(slipping.length, 'student has', 'students have')} dropped 10 points or more`,
        detail: slipping.slice(0, 4).map((s) => `${s.name} (${s.trend} points)`).join(', ')
          + ' — comparing their latest three papers with their first three.',
        action: { label: 'See the ranked list', to: '/admin/students' },
      });
    }

    // The weakest thing in the school, counted by children rather than by
    // percentage: one tag at 40% across six answers matters less than one at
    // 58% that sixty children are below.
    const worstSkill = [...skills].sort((a, b) => b.weak - a.weak || a.accuracy - b.accuracy)[0];
    if (worstSkill && worstSkill.weak > 0) {
      findings.push({
        id: 'weak-skill',
        severity: worstSkill.weak >= stats.students / 4 ? 'high' : 'medium',
        headline: `${worstSkill.weak} ${plural(worstSkill.weak, 'student is', 'students are')} below 60% on ${humanTag(worstSkill.key)}`,
        detail: `Across the whole cohort that skill sits at ${Math.round(worstSkill.accuracy * 100)}% `
          + `(${worstSkill.correct} of ${worstSkill.total} answers). It is the widest gap on the skill axis.`,
        action: { label: 'See who', to: `/admin/reports?tab=weakness&axis=skill&key=${encodeURIComponent(worstSkill.key)}` },
      });
    }

    // A gap between two classes sitting the same papers is a teaching signal
    // rather than a pupil one, so it is worth saying separately.
    if (classes.length >= 2) {
      const best = classes[0];
      const worst = classes[classes.length - 1];
      const gap = Math.round((best.avgPercentage - worst.avgPercentage) * 10) / 10;
      if (gap >= 10) {
        findings.push({
          id: 'class-gap',
          severity: 'medium',
          headline: `${worst.grade} ${worst.division} is ${gap} points behind ${best.grade} ${best.division}`,
          detail: `${worst.avgPercentage}% against ${best.avgPercentage}%, over ${worst.attempts} and ${best.attempts} papers.`,
          action: { label: 'Compare classes', to: '/admin/students' },
        });
      }
    }

    // A question almost nobody gets right is usually a wording problem, not a
    // hard question, and it is quietly costing every child marks until somebody
    // reads it.
    const broken = hardest.filter((h) => h.accuracy < 0.2);
    if (broken.length > 0) {
      findings.push({
        id: 'suspect-questions',
        severity: 'medium',
        headline: `${broken.length} ${plural(broken.length, 'question was', 'questions were')} answered correctly by fewer than 1 in 5`,
        detail: `Lowest: "${broken[0].preview}" — ${broken[0].correct} of ${broken[0].served} correct. `
          + 'That usually means the wording or the answer key, not the difficulty.',
        action: { label: 'Open the question bank', to: '/admin/questions' },
      });
    }

    if (unreleased.length > 0) {
      const total = unreleased.reduce((s, t) => s + t._count.attempts, 0);
      findings.push({
        id: 'unreleased-results',
        severity: 'medium',
        headline: `${unreleased.length} ${plural(unreleased.length, 'paper has', 'papers have')} marks nobody can see yet`,
        detail: `${total} submitted ${plural(total, 'paper', 'papers')} waiting to be released, including "${unreleased[0].title}". `
          + 'Students see "submitted, awaiting your teacher" until you release them.',
        action: { label: 'Release results', to: '/admin/tests' },
      });
    }

    if (drafts > 0) {
      findings.push({
        id: 'unreviewed-questions',
        severity: 'low',
        headline: `${drafts} generated ${plural(drafts, 'question is', 'questions are')} waiting for review`,
        detail: 'Nothing generated reaches a student until somebody approves it.',
        action: { label: 'Review them', to: '/admin/questions' },
      });
    }

    const order = { high: 0, medium: 1, low: 2 } as const;
    findings.sort((a, b) => order[a.severity] - order[b.severity]);

    return { findings, totals: stats, filter: q };
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

    const filter: AttemptFilter = { kind: q.kind, grade: q.grade, division: q.division };

    // The table itself, and each student's own worst tags, are two queries
    // rather than one per student: the second groups by student and tag in the
    // database and is then matched up here.
    const [rows, weakByStudent] = await Promise.all([
      studentRows(filter, q.minAttempts),
      weakTagsPerStudent(filter),
    ]);

    return {
      students: rows.map((s) => ({ ...s, weakAreas: weakByStudent.get(s.id) ?? [] })),
      filter: q,
    };
  });

  /**
   * Each student's four worst tags, from one query.
   *
   * Reported as part of the ranked table because "62% average" is a number a
   * teacher cannot act on, and "62%, weakest at fractions and ratios" is. The
   * same two guards as findWeakAreas: a minimum sample, and a confidence weight
   * so 4/10 outranks 1/3.
   */
  async function weakTagsPerStudent(filter: AttemptFilter): Promise<Map<string, WeakArea[]>> {
    const tallies = await studentTagTallies(filter);
    const out = new Map<string, WeakArea[]>();

    for (const t of tallies) {
      if (t.total < 3) continue;
      const accuracy = t.correct / t.total;
      if (accuracy >= 0.7) continue;
      const confidence = Math.min(1, t.total / 20);
      const list = out.get(t.userId) ?? [];
      list.push({
        axis: t.axis,
        key: t.key,
        accuracy: Math.round(accuracy * 100) / 100,
        correct: t.correct,
        total: t.total,
        priority: Math.round((1 - accuracy) * 100 * (0.5 + 0.5 * confidence)),
      });
      out.set(t.userId, list);
    }

    for (const [id, list] of out) {
      out.set(id, list.sort((a, b) => b.priority - a.priority).slice(0, 4));
    }
    return out;
  }

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
      // No breakdown: the tag mastery below is aggregated by the database, so
      // pulling every attempt's JSON here would be paying for it twice.
      select: {
        id: true, percentage: true, score: true, maxScore: true, submittedAt: true,
        correctCount: true, incorrectCount: true, unansweredCount: true,
        test: { select: { id: true, title: true, subject: true, kind: true } },
      },
    });

    const regular = attempts.filter((a) => a.test.kind === 'REGULAR');
    const practice = attempts.filter((a) => a.test.kind === 'PRACTICE');

    const merged = await tagTallies({ kind: 'REGULAR', userId: id }, ALL_AXES);
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

    const filter: AttemptFilter = {
      kind: q.kind,
      since: new Date(Date.now() - q.days * 86_400_000),
      grade: q.grade,
      division: q.division,
    };

    // Every tag anybody has actually been examined on, with the cohort figure
    // and how many children are below the line on it.
    const tags = await tagSummaries(filter, q.axis, q.threshold, q.minQuestions);

    if (!q.key) return { axis: q.axis, key: null as string | null, tags, students: [] as WeakStudent[], filter: q };

    const [tallies, papers] = await Promise.all([
      studentsOnTag(filter, q.axis, q.key),
      papersForTag(filter, q.axis, q.key),
    ]);

    const rows: WeakStudent[] = tallies
      .map((s) => {
        // The threshold is applied to the real figure, not the displayed one.
        // Rounding first dropped a child on 59.74% from the list of children
        // below 60% - they are below the line, and the line is what the list is
        // for. Only the number shown on screen is rounded.
        const exact = s.total ? s.correct / s.total : 0;
        return {
          student: {
            id: s.id, publicId: s.publicId, username: s.username,
            name: s.name, grade: s.grade, division: s.division, rollNo: s.rollNo,
          },
          correct: s.correct,
          total: s.total,
          accuracy: Math.round(exact * 100) / 100,
          exact,
          /** Too few questions to say anything - reported, never counted. */
          thin: s.total < q.minQuestions,
          papers: papers.get(s.id) ?? [],
        };
      })
      .filter((r) => r.total > 0 && (r.thin || r.exact < q.threshold))
      .sort((a, b) => Number(a.thin) - Number(b.thin) || a.exact - b.exact || b.total - a.total)
      .map(({ exact: _exact, ...row }) => row);

    return { axis: q.axis, key: q.key, tags, students: rows, filter: q };
  }

  /** Which papers each student met this tag on, for the expandable row. */
  async function papersForTag(filter: AttemptFilter, axis: WeakArea['axis'], key: string) {
    const rows = await paperTallies(filter, axis, key);
    const out = new Map<string, Array<{ testId: string; title: string; correct: number; total: number }>>();
    for (const r of rows) {
      const list = out.get(r.userId) ?? [];
      list.push({ testId: r.testId, title: r.title, correct: r.correct, total: r.total });
      out.set(r.userId, list);
    }
    return out;
  }

  /**
   * CSV export of all results, for a spreadsheet.
   *
   * Streamed in pages rather than assembled in memory. Every result the school
   * has ever recorded is by definition the largest thing this API produces, and
   * the version that built one big string held the whole export and the whole
   * query result at once - on a single-process API that is the download most
   * likely to take the exam down with it.
   */
  app.get('/api/admin/analytics/export.csv', async (request, reply) => {
    const q = z.object({ kind: z.enum(['REGULAR', 'PRACTICE', 'ALL']).default('ALL') }).parse(request.query);
    const kindFilter = q.kind === 'ALL' ? {} : { kind: q.kind };

    const header = [
      'username', 'first_name', 'last_name', 'grade', 'division', 'roll_no',
      'test_title', 'subject', 'test_kind', 'score', 'max_score', 'percentage',
      'correct', 'incorrect', 'unanswered', 'status', 'started_at', 'submitted_at',
    ];

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="results-${today()}.csv"`);

    const PAGE = 1000;
    async function* rows() {
      yield `${header.join(',')}\n`;
      let cursor: string | undefined;
      for (;;) {
        const page = await prisma.attempt.findMany({
          where: { status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] }, test: { ...kindFilter } },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            score: true, maxScore: true, percentage: true, submittedAt: true, startedAt: true,
            correctCount: true, incorrectCount: true, unansweredCount: true, status: true,
            user: { select: { username: true, firstName: true, lastName: true, grade: true, division: true, rollNo: true } },
            test: { select: { title: true, subject: true, kind: true } },
          },
        });
        if (page.length === 0) return;
        yield page
          .map((a) => [
            a.user.username, a.user.firstName, a.user.lastName, a.user.grade, a.user.division, a.user.rollNo,
            a.test.title, a.test.subject, a.test.kind, a.score, a.maxScore, a.percentage,
            a.correctCount, a.incorrectCount, a.unansweredCount, a.status,
            a.startedAt.toISOString(), a.submittedAt?.toISOString() ?? '',
          ].map(csvCell).join(',')).join('\n') + '\n';
        if (page.length < PAGE) return;
        cursor = page[page.length - 1].id;
      }
    }

    return reply.send(Readable.from(rows()));
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
