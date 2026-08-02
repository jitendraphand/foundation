import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticate, requireFreshPassword } from '../middleware/auth.js';
import { finalizeAttempt, buildLayout, publicQuestion, remainingMs, resultsAreVisible, sweepExpiredAttempts } from '../services/attempt.js';
import { findWeakAreas, type Breakdown } from '../lib/analytics.js';
import { validateResponse } from '../lib/grading.js';

export default async function studentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireFreshPassword);

  /** Dashboard: live tests, recent results, the percentage graph, weak areas. */
  app.get('/api/student/dashboard', async (request) => {
    const userId = request.user!.sub;

    // Close anything whose timer expired while the student was away, so the
    // dashboard never shows a stale "in progress".
    await sweepExpiredAttempts().catch(() => undefined);

    const me = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, publicId: true, firstName: true, lastName: true, username: true, grade: true, division: true, rollNo: true },
    });

    const now = new Date();

    const tests = await prisma.test.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          {
            OR: [
              // Regular tests scoped to this student's class (empty = everyone).
              {
                kind: 'REGULAR',
                AND: [
                  { OR: [{ targetGrades: { isEmpty: true } }, { targetGrades: { has: me.grade } }] },
                  { OR: [{ targetDivisions: { isEmpty: true } }, { targetDivisions: { has: me.division } }] },
                ],
              },
              // Practice tests assigned specifically to this student.
              { kind: 'PRACTICE', targetUserId: userId },
            ],
          },
        ],
      },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true, publicId: true, title: true, description: true, kind: true, subject: true,
        durationMinutes: true, marksPerQuestion: true, negativeMarks: true,
        maxAttempts: true, startsAt: true, endsAt: true, passPercentage: true,
        _count: { select: { questions: true } },
        attempts: {
          where: { userId },
          orderBy: { attemptNumber: 'desc' },
          select: { id: true, status: true, attemptNumber: true, percentage: true, expiresAt: true, submittedAt: true },
        },
      },
    });

    const available = tests.map((t) => {
      const used = t.attempts.filter((a) => a.status !== 'IN_PROGRESS').length;
      const inProgress = t.attempts.find((a) => a.status === 'IN_PROGRESS') ?? null;
      return {
        id: t.id,
        publicId: t.publicId,
        title: t.title,
        description: t.description,
        kind: t.kind,
        subject: t.subject,
        questionCount: t._count.questions,
        durationMinutes: t.durationMinutes,
        marksPerQuestion: t.marksPerQuestion,
        negativeMarks: t.negativeMarks,
        totalMarks: Math.round(t._count.questions * t.marksPerQuestion * 100) / 100,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        attemptsUsed: used,
        maxAttempts: t.maxAttempts,
        canAttempt: used < t.maxAttempts && t._count.questions > 0,
        inProgressAttemptId: inProgress?.id ?? null,
        lastPercentage: t.attempts.find((a) => a.status !== 'IN_PROGRESS')?.percentage ?? null,
      };
    });

    const attempts = await prisma.attempt.findMany({
      where: { userId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
      orderBy: { submittedAt: 'desc' },
      take: 60,
      select: {
        id: true, score: true, maxScore: true, percentage: true, submittedAt: true,
        correctCount: true, incorrectCount: true, unansweredCount: true, breakdown: true,
        test: { select: { id: true, publicId: true, title: true, subject: true, kind: true, passPercentage: true, resultsReleased: true } },
      },
    });

    // A submitted paper whose results have not been released yet must not leak
    // its score - not in the list, not in the averages, not in the charts.
    const released = attempts.filter((a) => resultsAreVisible(a.test));
    const pending = attempts.filter((a) => !resultsAreVisible(a.test));

    // Regular and practice results are kept apart everywhere, as specified.
    const regular = released.filter((a) => a.test.kind === 'REGULAR');
    const practice = released.filter((a) => a.test.kind === 'PRACTICE');

    const summary = (list: typeof attempts) => {
      if (list.length === 0) return { count: 0, avgPercentage: 0, bestPercentage: 0, lastPercentage: 0 };
      const pcts = list.map((a) => a.percentage);
      return {
        count: list.length,
        avgPercentage: Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 10) / 10,
        bestPercentage: Math.max(...pcts),
        lastPercentage: pcts[0],
      };
    };

    const weakAreas = findWeakAreas(
      released.map((a) => a.breakdown as unknown as Breakdown).filter(Boolean),
      { minSample: 3, accuracyThreshold: 0.7, limit: 6 },
    );

    return {
      me,
      liveTests: available,
      results: {
        regular: regular.map(shapeResult),
        practice: practice.map(shapeResult),
      },
      summary: { regular: summary(regular), practice: summary(practice) },
      // Shown as "submitted, awaiting your teacher" - no score attached.
      awaitingResults: pending.map((a) => ({
        attemptId: a.id,
        testId: a.test.id,
        testPublicId: a.test.publicId,
        title: a.test.title,
        subject: a.test.subject,
        submittedAt: a.submittedAt,
      })),
      weakAreas,
    };
  });

  /** Full result of one attempt, including correct answers if the test allows. */
  app.get('/api/student/attempts/:id/result', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const attempt = await prisma.attempt.findFirst({
      where: { id, userId: request.user!.sub },
      include: {
        test: true,
        answers: { include: { question: true } },
      },
    });

    if (!attempt) return reply.code(404).send({ error: 'Result not found.' });
    if (attempt.status === 'IN_PROGRESS') {
      return reply.code(409).send({ error: 'This attempt has not been submitted yet.' });
    }

    // Not released yet: confirm the paper was received, and nothing else. No
    // score, no marks, no questions, no answer keys.
    if (!resultsAreVisible(attempt.test)) {
      return {
        released: false,
        attempt: {
          id: attempt.id,
          status: attempt.status,
          startedAt: attempt.startedAt,
          submittedAt: attempt.submittedAt,
        },
        test: {
          id: attempt.test.id,
          publicId: attempt.test.publicId,
          title: attempt.test.title,
          subject: attempt.test.subject,
          kind: attempt.test.kind,
        },
        message: 'Your paper has been submitted. Your teacher will release the results for this test.',
      };
    }

    const testQuestions = await prisma.testQuestion.findMany({
      where: { testId: attempt.testId },
      include: { question: true },
      orderBy: { position: 'asc' },
    });

    const showAnswers = attempt.test.showAnswersAfter;
    const answerByQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const layout = attempt.layout as { questionIds?: string[]; optionOrder?: Record<string, string[]> };
    const order = layout?.questionIds ?? testQuestions.map((tq) => tq.questionId);

    const questions = order
      .map((qid) => testQuestions.find((tq) => tq.questionId === qid))
      .filter((tq): tq is NonNullable<typeof tq> => !!tq)
      .map((tq) => {
        const answer = answerByQuestion.get(tq.questionId);
        return {
          ...publicQuestion(tq.question, tq.marks, layout?.optionOrder?.[tq.questionId], showAnswers),
          yourResponse: answer?.response ?? null,
          isCorrect: answer?.isCorrect ?? null,
          marksAwarded: answer?.marksAwarded ?? 0,
          timeSpentMs: answer?.timeSpentMs ?? 0,
        };
      });

    return {
      released: true,
      attempt: {
        id: attempt.id,
        status: attempt.status,
        score: attempt.score,
        maxScore: attempt.maxScore,
        percentage: attempt.percentage,
        correctCount: attempt.correctCount,
        incorrectCount: attempt.incorrectCount,
        unansweredCount: attempt.unansweredCount,
        breakdown: attempt.breakdown,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
      },
      test: {
        id: attempt.test.id,
        publicId: attempt.test.publicId,
        title: attempt.test.title,
        subject: attempt.test.subject,
        kind: attempt.test.kind,
        passPercentage: attempt.test.passPercentage,
        showAnswersAfter: showAnswers,
      },
      questions,
    };
  });

  // --- Taking a test -------------------------------------------------------

  /** Starts a new attempt, or resumes the one already in progress. */
  app.post('/api/student/tests/:id/start', async (request, reply) => {
    const { id: testId } = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = request.user!.sub;

    const me = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { grade: true, division: true },
    });

    const test = await prisma.test.findFirst({
      where: { id: testId, status: 'PUBLISHED', deletedAt: null },
      include: { questions: { include: { question: true }, orderBy: { position: 'asc' } } },
    });

    if (!test) return reply.code(404).send({ error: 'That test is not available.' });

    // Eligibility.
    if (test.kind === 'PRACTICE') {
      if (test.targetUserId !== userId) return reply.code(403).send({ error: 'That practice test is not assigned to you.' });
    } else {
      const gradeOk = test.targetGrades.length === 0 || test.targetGrades.includes(me.grade);
      const divOk = test.targetDivisions.length === 0 || test.targetDivisions.includes(me.division);
      if (!gradeOk || !divOk) return reply.code(403).send({ error: 'That test is not assigned to your class.' });
    }

    const now = new Date();
    if (test.startsAt && test.startsAt > now) return reply.code(409).send({ error: 'That test has not opened yet.' });
    if (test.endsAt && test.endsAt < now) return reply.code(409).send({ error: 'That test has closed.' });
    if (test.questions.length === 0) return reply.code(409).send({ error: 'That test has no questions yet.' });

    const existing = await prisma.attempt.findFirst({
      where: { testId, userId, status: 'IN_PROGRESS' },
      orderBy: { attemptNumber: 'desc' },
    });

    if (existing) {
      // Resume — unless the timer ran out while they were away.
      if (existing.expiresAt <= now) {
        await finalizeAttempt(existing.id, true);
        return reply.code(409).send({ error: 'Your time for that attempt had already run out. It has been submitted.', attemptId: existing.id });
      }
      return { attemptId: existing.id, resumed: true };
    }

    const finished = await prisma.attempt.count({
      where: { testId, userId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
    });
    if (finished >= test.maxAttempts) {
      return reply.code(409).send({ error: `You have already used all ${test.maxAttempts} attempt${test.maxAttempts === 1 ? '' : 's'} for this test.` });
    }

    const attemptNumber = finished + 1;
    const seed = `${testId}:${userId}:${attemptNumber}`;
    const layout = buildLayout(test, test.questions, seed);

    const attempt = await prisma.attempt.create({
      data: {
        testId,
        userId,
        attemptNumber,
        layout: layout as object,
        // Server-authoritative deadline. The client clock is never trusted.
        expiresAt: new Date(Date.now() + test.durationMinutes * 60_000),
        maxScore: Math.round(test.questions.reduce((s, tq) => s + tq.marks, 0) * 100) / 100,
      },
    });

    // Pre-create answer rows so autosave is a plain update, never an upsert race.
    await prisma.answer.createMany({
      data: test.questions.map((tq) => ({ attemptId: attempt.id, questionId: tq.questionId })),
      skipDuplicates: true,
    });

    return { attemptId: attempt.id, resumed: false };
  });

  /** The live paper. Answer keys are never included. */
  app.get('/api/student/attempts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const attempt = await prisma.attempt.findFirst({
      where: { id, userId: request.user!.sub },
      include: { test: true, answers: true },
    });
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found.' });

    if (attempt.status !== 'IN_PROGRESS') {
      return reply.code(409).send({ error: 'This attempt has already been submitted.', submitted: true });
    }
    if (attempt.expiresAt <= new Date()) {
      await finalizeAttempt(attempt.id, true);
      return reply.code(409).send({ error: 'Your time has run out. The attempt has been submitted.', submitted: true });
    }

    const testQuestions = await prisma.testQuestion.findMany({
      where: { testId: attempt.testId },
      include: { question: true },
    });

    const layout = attempt.layout as { questionIds?: string[]; optionOrder?: Record<string, string[]> };
    const order = layout?.questionIds ?? testQuestions.map((tq) => tq.questionId);
    const answerByQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));

    const questions = order
      .map((qid) => testQuestions.find((tq) => tq.questionId === qid))
      .filter((tq): tq is NonNullable<typeof tq> => !!tq)
      .map((tq) => {
        const answer = answerByQuestion.get(tq.questionId);
        return {
          ...publicQuestion(tq.question, tq.marks, layout?.optionOrder?.[tq.questionId], false),
          yourResponse: answer?.response ?? null,
          isMarkedForReview: answer?.isMarkedForReview ?? false,
        };
      });

    await prisma.attempt.update({ where: { id: attempt.id }, data: { lastSeenAt: new Date() } });

    return {
      attempt: {
        id: attempt.id,
        startedAt: attempt.startedAt,
        expiresAt: attempt.expiresAt,
        remainingMs: remainingMs(attempt),
        attemptNumber: attempt.attemptNumber,
      },
      test: {
        id: attempt.test.id,
        title: attempt.test.title,
        subject: attempt.test.subject,
        kind: attempt.test.kind,
        durationMinutes: attempt.test.durationMinutes,
        negativeMarks: attempt.test.negativeMarks,
        totalMarks: attempt.maxScore,
      },
      questions,
    };
  });

  /**
   * Autosave. Called on every change, so it must be cheap and must never
   * reject a legitimate answer. Returns the authoritative remaining time so
   * the client's countdown re-syncs continuously.
   */
  app.post('/api/student/attempts/:id/answer', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        questionId: z.string().uuid(),
        response: z.any().nullable(),
        timeSpentMs: z.number().int().min(0).max(86_400_000).optional(),
        isMarkedForReview: z.boolean().optional(),
      })
      .parse(request.body);

    const attempt = await prisma.attempt.findFirst({
      where: { id, userId: request.user!.sub },
      select: { id: true, status: true, expiresAt: true, testId: true },
    });
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found.' });
    if (attempt.status !== 'IN_PROGRESS') return reply.code(409).send({ error: 'This attempt has already been submitted.' });

    if (attempt.expiresAt <= new Date()) {
      await finalizeAttempt(attempt.id, true);
      return reply.code(409).send({ error: 'Your time has run out. The attempt has been submitted.', submitted: true });
    }

    const tq = await prisma.testQuestion.findFirst({
      where: { testId: attempt.testId, questionId: body.questionId },
      include: { question: { select: { format: true, options: true } } },
    });
    if (!tq) return reply.code(400).send({ error: 'That question is not part of this test.' });

    // Validate shape, and that a chosen option actually exists.
    let response: unknown = null;
    if (body.response !== null && body.response !== undefined) {
      try {
        response = validateResponse(tq.question.format, body.response);
      } catch {
        return reply.code(400).send({ error: 'That answer is not valid for this question type.' });
      }
      const optionIds = new Set(((tq.question.options as Array<{ id: string }>) ?? []).map((o) => o.id));
      if (tq.question.format === 'MCQ_SINGLE' && !optionIds.has((response as { optionId: string }).optionId)) {
        return reply.code(400).send({ error: 'That option does not exist.' });
      }
      if (tq.question.format === 'MCQ_MULTI') {
        const ids = (response as { optionIds: string[] }).optionIds;
        if (ids.some((o) => !optionIds.has(o))) return reply.code(400).send({ error: 'That option does not exist.' });
      }
    }

    // A cleared answer must become SQL NULL, which Prisma spells Prisma.DbNull.
    const storedResponse = response === null ? Prisma.DbNull : (response as Prisma.InputJsonValue);

    await prisma.answer.upsert({
      where: { attemptId_questionId: { attemptId: attempt.id, questionId: body.questionId } },
      create: {
        attemptId: attempt.id,
        questionId: body.questionId,
        response: storedResponse,
        timeSpentMs: body.timeSpentMs ?? 0,
        isMarkedForReview: body.isMarkedForReview ?? false,
        answeredAt: response ? new Date() : null,
        visitCount: 1,
      },
      update: {
        response: storedResponse,
        ...(body.timeSpentMs !== undefined ? { timeSpentMs: body.timeSpentMs } : {}),
        ...(body.isMarkedForReview !== undefined ? { isMarkedForReview: body.isMarkedForReview } : {}),
        answeredAt: response ? new Date() : null,
        visitCount: { increment: 1 },
      },
    });

    await prisma.attempt.update({ where: { id: attempt.id }, data: { lastSeenAt: new Date() } });

    return { ok: true, remainingMs: Math.max(0, attempt.expiresAt.getTime() - Date.now()) };
  });

  /** Heartbeat so the countdown stays honest across sleep/reconnect. */
  app.get('/api/student/attempts/:id/tick', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const attempt = await prisma.attempt.findFirst({
      where: { id, userId: request.user!.sub },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found.' });

    if (attempt.status === 'IN_PROGRESS' && attempt.expiresAt <= new Date()) {
      await finalizeAttempt(attempt.id, true);
      return { submitted: true, remainingMs: 0 };
    }
    return {
      submitted: attempt.status !== 'IN_PROGRESS',
      remainingMs: Math.max(0, attempt.expiresAt.getTime() - Date.now()),
    };
  });

  app.post('/api/student/attempts/:id/submit', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const attempt = await prisma.attempt.findFirst({
      where: { id, userId: request.user!.sub },
      select: { id: true, status: true },
    });
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found.' });
    if (attempt.status !== 'IN_PROGRESS') return { ok: true, alreadySubmitted: true, attemptId: attempt.id };

    const finished = await finalizeAttempt(attempt.id, false);
    const visible = resultsAreVisible(finished.test);

    // The score is deliberately omitted unless results are already visible,
    // so a student cannot read it out of the network response.
    return {
      ok: true,
      attemptId: finished.id,
      released: visible,
      ...(visible
        ? { score: finished.score, maxScore: finished.maxScore, percentage: finished.percentage }
        : { message: 'Your paper has been submitted. Your teacher will release the results for this test.' }),
    };
  });
}

function shapeResult(a: {
  id: string;
  score: number;
  maxScore: number;
  percentage: number;
  submittedAt: Date | null;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  test: { id: string; title: string; subject: string; kind: string; passPercentage: number };
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
    passed: a.percentage >= a.test.passPercentage,
    correctCount: a.correctCount,
    incorrectCount: a.incorrectCount,
    unansweredCount: a.unansweredCount,
    submittedAt: a.submittedAt,
  };
}
