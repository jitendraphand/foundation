import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { audit, requirePermission } from '../../middleware/auth.js';
import { ownedBy, type Actor } from '../../lib/ownership.js';
import { inAudience } from '../../lib/audience.js';
import { csvFile } from '../../lib/csv.js';

const testFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  kind: z.enum(['REGULAR', 'PRACTICE']).default('REGULAR'),
  subject: z.string().trim().min(1).max(120),
  grade: z.string().max(20).optional().nullable(),
  targetGrades: z.array(z.string().max(20)).max(20).default([]),
  targetDivisions: z.array(z.string().max(20)).max(20).default([]),
  targetUserId: z.string().uuid().optional().nullable(),
  marksPerQuestion: z.number().min(0.25).max(100).default(1),
  negativeMarks: z.number().min(0).max(100).default(0),
  durationMinutes: z.number().int().min(1).max(600).default(30),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  passPercentage: z.number().min(0).max(100).default(35),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  showAnswersAfter: z.boolean().default(true),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),

  // Daily availability window. Minutes from local midnight in the school's
  // timezone; an end before the start wraps past midnight.
  availabilityMode: z.enum(['ALWAYS', 'ALLOW_WINDOW', 'BLOCK_WINDOW']).default('ALWAYS'),
  windowStartMinute: z.number().int().min(0).max(1439).optional().nullable(),
  windowEndMinute: z.number().int().min(0).max(1439).optional().nullable(),
  windowDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  autoSubmitOnClose: z.boolean().default(false),

  /**
   * Optional proctoring. Stored in meta rather than as columns because it is
   * three settings on a minority of tests, and meta is exactly the escape
   * hatch that keeps a change like this off the migration path.
   */
  proctoring: z
    .object({
      enabled: z.boolean().default(false),
      allowance: z.number().int().min(1).max(20).default(3),
      requireFullscreen: z.boolean().default(true),
    })
    .optional(),

  /**
   * Whether each question's own time limit is enforced while the paper is sat.
   * Stored in meta rather than a column because it is one switch on a minority
   * of tests; see the schema note on the escape hatch. Off by default: a
   * per-question cutoff punishes slow readers and breaks skip-and-return, so a
   * school turns it on deliberately for papers that need pacing.
   */
  perQuestionTiming: z.boolean().optional(),
});

/** A window is only meaningful with both ends set, and they must differ. */
const windowIsComplete = (t: {
  availabilityMode?: string;
  windowStartMinute?: number | null;
  windowEndMinute?: number | null;
}) =>
  !t.availabilityMode ||
  t.availabilityMode === 'ALWAYS' ||
  (t.windowStartMinute !== null && t.windowStartMinute !== undefined &&
   t.windowEndMinute !== null && t.windowEndMinute !== undefined &&
   t.windowStartMinute !== t.windowEndMinute);

const WINDOW_ERROR = 'A daily window needs a start time and an end time, and they must be different.';

const testSchema = testFields.refine(windowIsComplete, { message: WINDOW_ERROR });

/** The same ownership rule the question bank applies; see lib/ownership.ts. */
function questionsVisibleTo(request: Actor) {
  return ownedBy(request, 'createdById', true);
}

/**
 * And the same rule for the papers themselves.
 *
 * A test is one colleague's work in the same way a question is: they chose its
 * questions, its marking scheme and its audience. Seeing every paper in the
 * school is the invigilator's job rather than a side effect of being able to
 * make one, so it takes content.viewAll.
 *
 * Applied to every route that takes an id, not only the listing: an id copied
 * from a colleague's URL would otherwise open their paper, answer keys and all.
 */
export function testsVisibleTo(request: Actor) {
  return ownedBy(request, 'createdById');
}

/**
 * Whether a paper's question list may still be changed, and why not.
 *
 * Two separate reasons, and they are not the same thing. A sat test is frozen
 * because its results are computed from exactly these questions. A published
 * test is frozen because it is live to students right now - nobody may have
 * started yet, but the paper is out, and quietly changing what is on it while
 * it is available is how two students end up sitting different exams.
 *
 * Publishing is reversible, so this is a lock rather than a dead end: move the
 * test back to draft, change it, publish again.
 */
function compositionLock(test: { status: string; _count: { attempts: number } }): string | null {
  if (test._count.attempts > 0) {
    return 'Students have already attempted this test, so its questions can no longer be changed.';
  }
  if (test.status === 'PUBLISHED') {
    return 'This test is published and live to students, so its questions cannot be changed. Move it back to draft first, then edit it.';
  }
  if (test.status === 'CLOSED') {
    return 'This test is closed, so its questions can no longer be changed. Move it back to draft to reopen it for editing.';
  }
  return null;
}

export default async function adminTestRoutes(app: FastifyInstance) {
  app.get('/api/admin/tests', async (request) => {
    const q = z
      .object({
        kind: z.enum(['REGULAR', 'PRACTICE']).optional(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']).optional(),
        targetUserId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const where = {
      deletedAt: null,
      ...testsVisibleTo(request),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.targetUserId ? { targetUserId: q.targetUserId } : {}),
    };

    const [total, tests] = await Promise.all([
      prisma.test.count({ where }),
      prisma.test.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          _count: { select: { questions: true, attempts: true } },
          targetUser: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, tests };
  });

  app.get('/api/admin/tests/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const test = await prisma.test.findFirst({
      where: { id, deletedAt: null, ...testsVisibleTo(request) },
      include: {
        questions: { include: { question: true }, orderBy: { position: 'asc' } },
        targetUser: { select: { id: true, username: true, firstName: true, lastName: true } },
        _count: { select: { attempts: true } },
      },
    });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });
    return { test };
  });

  app.post('/api/admin/tests', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const body = testSchema.parse(request.body);

    if (body.kind === 'PRACTICE' && !body.targetUserId) {
      return reply.code(400).send({ error: 'A practice test must be assigned to one student.' });
    }

    // proctoring is three settings inside meta, not a column, so it has to come
    // out of the spread. Left in, Prisma rejects the whole create with "Unknown
    // argument `proctoring`" - which meant a test could never be created as
    // proctored at all, only created and then patched.
    const { proctoring, perQuestionTiming, ...fields } = body;

    const test = await prisma.test.create({
      data: {
        ...fields,
        ...(proctoring || perQuestionTiming !== undefined
          ? { meta: {
              ...(proctoring ? { proctoring } : {}),
              ...(perQuestionTiming !== undefined ? { perQuestionTiming } : {}),
            } as unknown as Prisma.InputJsonValue }
          : {}),
        description: body.description ?? null,
        grade: body.grade ?? null,
        targetUserId: body.targetUserId ?? null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        createdById: request.user!.sub,
      },
    });

    await audit(request.user!.sub, 'test.create', { entity: 'Test', entityId: test.id, ip: request.ip });
    return reply.code(201).send({ ok: true, test });
  });

  app.patch('/api/admin/tests/:id', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = testFields.partial().parse(request.body);

    // Merged against the stored row, because a PATCH may set only the mode.
    const existingForWindow = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) } });
    if (!existingForWindow) return reply.code(404).send({ error: 'Test not found.' });
    if (!windowIsComplete({
      availabilityMode: body.availabilityMode ?? existingForWindow.availabilityMode,
      windowStartMinute: body.windowStartMinute ?? existingForWindow.windowStartMinute,
      windowEndMinute: body.windowEndMinute ?? existingForWindow.windowEndMinute,
    })) {
      return reply.code(400).send({ error: WINDOW_ERROR });
    }

    const existing = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) }, include: { _count: { select: { attempts: true } } } });
    if (!existing) return reply.code(404).send({ error: 'Test not found.' });

    // Changing the marking scheme after students have sat the test would make
    // existing scores meaningless.
    if (existing._count.attempts > 0) {
      const locked = ['marksPerQuestion', 'negativeMarks', 'durationMinutes'] as const;
      const changed = locked.filter((f) => body[f] !== undefined && body[f] !== existing[f]);
      if (changed.length > 0) {
        return reply.code(409).send({
          error: `Students have already attempted this test, so ${changed.join(', ')} can no longer be changed. Create a new test instead.`,
        });
      }
    }

    const { proctoring, perQuestionTiming, ...fields } = body;

    const test = await prisma.test.update({
      where: { id },
      data: {
        ...fields,
        ...(proctoring || perQuestionTiming !== undefined
          ? { meta: {
              ...((existing.meta ?? {}) as object),
              ...(proctoring ? { proctoring } : {}),
              ...(perQuestionTiming !== undefined ? { perQuestionTiming } : {}),
            } as unknown as Prisma.InputJsonValue }
          : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt ? new Date(body.startsAt) : null } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt ? new Date(body.endsAt) : null } : {}),
      },
    });

    await audit(request.user!.sub, 'test.update', { entity: 'Test', entityId: id, ip: request.ip });
    return { ok: true, test };
  });

  /** Sets the final question list — the "these drafts become the test" step. */
  app.put('/api/admin/tests/:id/questions', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        questionIds: z.array(z.string().uuid()).min(1),
        /** Per-question override; falls back to the test's marksPerQuestion. */
        marks: z.record(z.number().min(0.25).max(100)).optional(),
        /** Per-question time limit in seconds; falls back to the question's estimatedSeconds. */
        timeLimitSeconds: z.record(z.number().int().min(1)).optional(),
      })
      .parse(request.body);

    const test = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) }, include: { _count: { select: { attempts: true } } } });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });
    const locked = compositionLock(test);
    if (locked) return reply.code(409).send({ error: locked });

    // Scoped to what this administrator can see, so a question id copied from
    // a colleague's bank cannot be pulled onto a paper.
    const found = await prisma.question.findMany({
      where: { id: { in: body.questionIds }, deletedAt: null, ...questionsVisibleTo(request) },
      select: { id: true, status: true, estimatedSeconds: true },
    });

    const missing = body.questionIds.filter((qid) => !found.some((f) => f.id === qid));
    if (missing.length) return reply.code(400).send({ error: `${missing.length} of the selected questions no longer exist.` });

    const notApproved = found.filter((f) => f.status !== 'APPROVED');
    if (notApproved.length) {
      return reply.code(400).send({
        error: `${notApproved.length} of the selected questions are not approved yet. Approve them first, then add them to the test.`,
      });
    }

    await prisma.$transaction([
      prisma.testQuestion.deleteMany({ where: { testId: id } }),
      prisma.testQuestion.createMany({
        data: body.questionIds.map((qid, index) => ({
          testId: id,
          questionId: qid,
          position: index,
          marks: body.marks?.[qid] ?? test.marksPerQuestion,
          timeLimitSeconds: body.timeLimitSeconds?.[qid] ?? found.find((f) => f.id === qid)?.estimatedSeconds,
        })),
      }),
    ]);

    await audit(request.user!.sub, 'test.set_questions', {
      entity: 'Test', entityId: id, ip: request.ip, detail: { count: body.questionIds.length },
    });

    return { ok: true, count: body.questionIds.length };
  });

  /**
   * Appends questions to a test, keeping what is already there.
   *
   * The PUT above replaces the whole paper, which is right when the builder
   * owns the list. This exists for the other direction: an admin who has just
   * approved a batch in the question bank and wants them on a paper without
   * leaving that screen.
   */
  app.post('/api/admin/tests/:id/questions/add', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ questionIds: z.array(z.string().uuid()).min(1) }).parse(request.body);

    const test = await prisma.test.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { attempts: true } }, questions: { select: { questionId: true, position: true } } },
    });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });
    const locked = compositionLock(test);
    if (locked) return reply.code(409).send({ error: locked });

    const already = new Set(test.questions.map((q) => q.questionId));
    const wanted = [...new Set(body.questionIds)];
    const toAdd = wanted.filter((qid) => !already.has(qid));
    const skippedDuplicate = wanted.length - toAdd.length;

    const found = await prisma.question.findMany({
      where: { id: { in: toAdd }, deletedAt: null, ...questionsVisibleTo(request) },
      select: { id: true, status: true, subject: true },
    });

    const missing = toAdd.filter((qid) => !found.some((f) => f.id === qid));
    const notApproved = found.filter((f) => f.status !== 'APPROVED');
    const approved = found.filter((f) => f.status === 'APPROVED');

    if (approved.length === 0) {
      return reply.code(400).send({
        error:
          notApproved.length > 0
            ? `None of those questions are approved yet. Approve them first, then add them to a test.`
            : skippedDuplicate > 0
              ? 'Those questions are already on this test.'
              : 'Those questions no longer exist.',
      });
    }

    // Appended in the order they were selected, after whatever is on the paper.
    const nextPosition = test.questions.reduce((max, q) => Math.max(max, q.position + 1), 0);
    const ordered = toAdd.filter((qid) => approved.some((a) => a.id === qid));

    await prisma.testQuestion.createMany({
      data: ordered.map((qid, i) => ({
        testId: id,
        questionId: qid,
        position: nextPosition + i,
        marks: test.marksPerQuestion,
      })),
    });

    await audit(request.user!.sub, 'test.add_questions', {
      entity: 'Test', entityId: id, ip: request.ip, detail: { added: ordered.length },
    });

    const total = test.questions.length + ordered.length;
    const notes = [
      skippedDuplicate > 0 ? `${skippedDuplicate} already on the paper` : null,
      notApproved.length > 0 ? `${notApproved.length} not approved yet` : null,
      missing.length > 0 ? `${missing.length} no longer exist` : null,
    ].filter(Boolean);

    // A question from another subject is allowed - a revision paper may well
    // mix them - but it is worth saying out loud rather than doing it silently.
    const otherSubject = approved.filter((a) => a.subject.toLowerCase() !== test.subject.toLowerCase()).length;

    return {
      ok: true,
      added: ordered.length,
      total,
      message:
        `${ordered.length} question${ordered.length === 1 ? '' : 's'} added to ${test.title}. ` +
        `The paper now has ${total}.` +
        (notes.length ? ` Skipped: ${notes.join(', ')}.` : '') +
        (otherSubject > 0
          ? ` Note that ${otherSubject} ${otherSubject === 1 ? 'is' : 'are'} filed under a different subject to this test.`
          : ''),
    };
  });

  app.post('/api/admin/tests/:id/publish', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED']) }).parse(request.body);

    const test = await prisma.test.findFirst({
      where: { id, deletedAt: null, ...testsVisibleTo(request) },
      include: { _count: { select: { questions: true } } },
    });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    if (status === 'PUBLISHED' && test._count.questions === 0) {
      return reply.code(400).send({ error: 'Add questions to this test before publishing it.' });
    }

    const updated = await prisma.test.update({
      where: { id },
      data: { status, publishedAt: status === 'PUBLISHED' ? new Date() : test.publishedAt },
    });

    await audit(request.user!.sub, `test.${status.toLowerCase()}`, { entity: 'Test', entityId: id, ip: request.ip });

    return {
      ok: true,
      test: updated,
      message:
        status === 'PUBLISHED'
          ? 'The test is now live and will appear on the students’ dashboards.'
          : status === 'CLOSED'
            ? 'The test is closed. No new attempts can be started.'
            : 'The test has been moved back to draft and is hidden from students.',
    };
  });

  /**
   * Releases (or withdraws) the results for a whole test.
   *
   * Submitting never shows a student their score; this is the action that
   * does. Practice tests are excluded - they are for the student to learn
   * from, so their results are always immediate.
   */
  app.post('/api/admin/tests/:id/release', { preHandler: requirePermission('results.release') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { released } = z.object({ released: z.boolean() }).parse(request.body);

    const test = await prisma.test.findFirst({
      where: { id, deletedAt: null, ...testsVisibleTo(request) },
      include: { _count: { select: { attempts: true } } },
    });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    if (test.kind === 'PRACTICE') {
      return reply.code(400).send({
        error: 'Practice test results are always visible to the student straight away, so there is nothing to release.',
      });
    }

    const inProgress = await prisma.attempt.count({ where: { testId: id, status: 'IN_PROGRESS' } });

    const updated = await prisma.test.update({
      where: { id },
      data: {
        resultsReleased: released,
        resultsReleasedAt: released ? new Date() : null,
        releasedById: released ? request.user!.sub : null,
      },
    });

    await audit(request.user!.sub, released ? 'test.results_released' : 'test.results_withdrawn', {
      entity: 'Test', entityId: id, ip: request.ip,
      detail: { attempts: test._count.attempts, inProgressAtRelease: inProgress },
    });

    const submitted = test._count.attempts - inProgress;

    return {
      ok: true,
      test: updated,
      inProgress,
      message: released
        ? `Results released. ${submitted} student${submitted === 1 ? '' : 's'} can now see their score.` +
          (inProgress > 0
            ? ` Note that ${inProgress} student${inProgress === 1 ? ' is' : 's are'} still writing - they will see their result as soon as they submit.`
            : '')
        : 'Results withdrawn. Students can no longer see their score for this test.',
    };
  });

  app.delete('/api/admin/tests/:id', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const test = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) }, include: { _count: { select: { attempts: true } } } });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    // Always hard-delete, even when the test has past attempts. The caller has
    // confirmed they want the test and all its attempts/answers removed.
    // We still collect the live difficulty counters so observedP stays correct.
    const attempts = await prisma.attempt.findMany({ where: { testId: id }, select: { id: true } });
    const attemptIds = attempts.map((a) => a.id);
    const answers = attemptIds.length
      ? await prisma.answer.findMany({
          where: { attemptId: { in: attemptIds }, isCorrect: { not: null } },
          select: { questionId: true, isCorrect: true },
        })
      : [];
    const hitByQ = new Map<string, { served: number; correct: number }>();
    for (const a of answers) {
      const entry = hitByQ.get(a.questionId) ?? { served: 0, correct: 0 };
      entry.served += 1;
      if (a.isCorrect) entry.correct += 1;
      hitByQ.set(a.questionId, entry);
    }

    await prisma.$transaction(async (tx) => {
      for (const [qid, counts] of hitByQ) {
        await tx.$executeRaw`
          UPDATE "Question" SET "timesServed" = GREATEST(0, "timesServed" - ${counts.served}::int),
            "timesCorrect" = GREATEST(0, "timesCorrect" - ${counts.correct}::int),
            "observedP" = CASE WHEN "timesServed" <= ${counts.served}::int THEN 0 ELSE (("timesCorrect" - ${counts.correct}::int)::float / GREATEST(1, "timesServed" - ${counts.served}::int)) END
          WHERE id = ${qid}
        `;
      }
      await tx.test.delete({ where: { id } });
    });
    await audit(request.user!.sub, 'test.delete', { entity: 'Test', entityId: id, ip: request.ip, detail: { deletedAttempts: attemptIds.length } });
    return { ok: true, mode: 'hard' };
  });

  // --- Attempt deletion (admin) -------------------------------------------

  /** Deletes a single attempt (e.g. to let a student retry or remove a mistaken submission). */
  app.delete('/api/admin/attempts/:id', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const attempt = await prisma.attempt.findUnique({
      where: { id },
      include: { answers: true, test: true },
    });
    if (!attempt) return reply.code(404).send({ error: 'Attempt not found.' });

    // Ownership: must be able to see the test this attempt belongs to
    const testVisible = await prisma.test.findFirst({ where: { id: attempt.testId, ...testsVisibleTo(request) } });
    if (!testVisible) return reply.code(404).send({ error: 'Attempt not found.' });

    // Adjust live difficulty counters if this attempt had been counted
    const counted = attempt.status === 'SUBMITTED' || attempt.status === 'AUTO_SUBMITTED';
    if (counted && attempt.answers.length > 0) {
      const hitByQ = new Map<string, number>();
      for (const a of attempt.answers) {
        if (a.isCorrect === null || a.isCorrect === undefined) continue;
        // Only counted answers contribute to timesServed
        hitByQ.set(a.questionId, (hitByQ.get(a.questionId) ?? 0) + (a.isCorrect ? 1 : 0));
      }
      if (hitByQ.size > 0) {
        await prisma.$transaction(async (tx) => {
          // Delete answers first (FK)
          await tx.answer.deleteMany({ where: { attemptId: id } });
          await tx.attempt.delete({ where: { id } });
          // Decrement live stats
          for (const [qid, hit] of hitByQ) {
            await tx.$executeRaw`
              UPDATE "Question" SET "timesServed" = GREATEST(0, "timesServed" - 1),
                "timesCorrect" = GREATEST(0, "timesCorrect" - ${hit}::int),
                "observedP" = CASE WHEN "timesServed" <= 1 THEN 0 ELSE (("timesCorrect" - ${hit}::int)::float / (GREATEST(1, "timesServed" - 1))) END
              WHERE id = ${qid}
            `;
          }
        });
      } else {
        await prisma.$transaction([prisma.answer.deleteMany({ where: { attemptId: id } }), prisma.attempt.delete({ where: { id } })]);
      }
    } else {
      await prisma.$transaction([prisma.answer.deleteMany({ where: { attemptId: id } }), prisma.attempt.delete({ where: { id } })]);
    }

    await audit(request.user!.sub, 'attempt.delete', { entity: 'Attempt', entityId: id, ip: request.ip, detail: { testId: attempt.testId, userId: attempt.userId, status: attempt.status } });
    return { ok: true, message: 'Attempt deleted.' };
  });

  /** Deletes ALL attempts (and answers) for a given test — full purge of test data. */
  app.delete('/api/admin/tests/:id/attempts', { preHandler: requirePermission('tests.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ confirm: z.string().optional() }).parse(request.body ?? {});

    // Require explicit confirmation to avoid accidental clicks
    if (body.confirm !== 'DELETE') {
      return reply.code(400).send({ error: 'Please confirm by sending { confirm: "DELETE" } in the request body.' });
    }

    const test = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) } });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    const attempts = await prisma.attempt.findMany({ where: { testId: id }, select: { id: true, status: true } });
    if (attempts.length === 0) return { ok: true, deleted: 0, message: 'No attempts to delete for this test.' };

    const inProgress = attempts.filter((a) => a.status === 'IN_PROGRESS').length;
    if (inProgress > 0) {
      return reply.code(409).send({ error: `Cannot purge: ${inProgress} student${inProgress === 1 ? '' : 's'} currently writing this test. Try again after they submit.` });
    }

    // Collect which questions were counted for live stats
    const answers = await prisma.answer.findMany({
      where: { attemptId: { in: attempts.map((a) => a.id) }, isCorrect: { not: null } },
      select: { questionId: true, isCorrect: true },
    });
    const hitByQ = new Map<string, { served: number; correct: number }>();
    for (const a of answers) {
      const entry = hitByQ.get(a.questionId) ?? { served: 0, correct: 0 };
      entry.served += 1;
      if (a.isCorrect) entry.correct += 1;
      hitByQ.set(a.questionId, entry);
    }

    const attemptIds = attempts.map((a) => a.id);
    await prisma.$transaction(async (tx) => {
      await tx.answer.deleteMany({ where: { attemptId: { in: attemptIds } } });
      await tx.attempt.deleteMany({ where: { id: { in: attemptIds } } });
      for (const [qid, counts] of hitByQ) {
        await tx.$executeRaw`
          UPDATE "Question" SET "timesServed" = GREATEST(0, "timesServed" - ${counts.served}::int),
            "timesCorrect" = GREATEST(0, "timesCorrect" - ${counts.correct}::int),
            "observedP" = CASE WHEN "timesServed" <= ${counts.served}::int THEN 0 ELSE (("timesCorrect" - ${counts.correct}::int)::float / GREATEST(1, "timesServed" - ${counts.served}::int)) END
          WHERE id = ${qid}
        `;
      }
    });

    await audit(request.user!.sub, 'test.purge_attempts', { entity: 'Test', entityId: id, ip: request.ip, detail: { deletedAttempts: attempts.length } });
    return { ok: true, deleted: attempts.length, message: `Deleted ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} and all associated answers for this test.` };
  });

  /** Live results for one test, for the invigilator's view. */
  app.get('/api/admin/tests/:id/results', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const test = await prisma.test.findFirst({ where: { id, deletedAt: null, ...testsVisibleTo(request) } });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    const attempts = await prisma.attempt.findMany({
      where: { testId: id },
      orderBy: [{ percentage: 'desc' }],
      select: {
        id: true, status: true, score: true, maxScore: true, percentage: true,
        correctCount: true, incorrectCount: true, unansweredCount: true,
        startedAt: true, submittedAt: true, breakdown: true,
        user: { select: { id: true, username: true, firstName: true, lastName: true, grade: true, division: true, rollNo: true } },
      },
    });

    const done = attempts.filter((a) => a.status === 'SUBMITTED' || a.status === 'AUTO_SUBMITTED');
    const pcts = done.map((a) => a.percentage).sort((a, b) => a - b);

    const stats = {
      attempted: attempts.length,
      completed: done.length,
      inProgress: attempts.filter((a) => a.status === 'IN_PROGRESS').length,
      average: pcts.length ? Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 10) / 10 : 0,
      median: pcts.length ? pcts[Math.floor(pcts.length / 2)] : 0,
      highest: pcts.length ? pcts[pcts.length - 1] : 0,
      lowest: pcts.length ? pcts[0] : 0,
      passed: done.filter((a) => a.percentage >= test.passPercentage).length,
    };

    // Per-question difficulty on this specific test, to spot bad questions.
    const perQuestion = await prisma.answer.groupBy({
      by: ['questionId', 'isCorrect'],
      where: { attempt: { testId: id, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } } },
      _count: { _all: true },
    });

    const questionStats: Record<string, { correct: number; incorrect: number; unanswered: number }> = {};
    for (const row of perQuestion) {
      const entry = (questionStats[row.questionId] ??= { correct: 0, incorrect: 0, unanswered: 0 });
      if (row.isCorrect === true) entry.correct += row._count._all;
      else if (row.isCorrect === false) entry.incorrect += row._count._all;
      else entry.unanswered += row._count._all;
    }

    return { test, stats, attempts, questionStats };
  });

  // --- Per-test downloads ----------------------------------------------------
  // Attempted / non-attempted rosters and the results table, as spreadsheets.
  // Email and mobile are a System Administrator's fields (see users.ts), so
  // they are only included for a caller holding admins.manage — the same rule
  // the on-screen lists apply.

  /** Whether this caller may see contact details in a download. */
  function maySeeContacts(request: Actor): boolean {
    return (request.user?.permissions ?? []).includes('admins.manage');
  }

  interface RosterStudent {
    id: string;
    publicId: string;
    username: string;
    firstName: string;
    lastName: string;
    grade: string;
    division: string;
    rollNo: string;
    email: string | null;
    mobile: string | null;
    lastLoginAt: Date | null;
  }

  const ATTEMPT_RANK = { SUBMITTED: 3, AUTO_SUBMITTED: 3, IN_PROGRESS: 2, ABANDONED: 1 } as const;

  /**
   * The test, its audience and everyone's best attempt, shared by the three
   * downloads. Best attempt per student: a submitted resit beats an abandoned
   * first go, so nobody is counted as missing a paper they sat.
   */
  async function roster(request: Actor, testId: string) {
    const test = await prisma.test.findFirst({ where: { id: testId, deletedAt: null, ...testsVisibleTo(request) } });
    if (!test) return null;

    const [students, attempts] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'STUDENT', deletedAt: null, isActive: true },
        orderBy: [{ grade: 'asc' }, { division: 'asc' }, { rollNo: 'asc' }],
        select: {
          id: true, publicId: true, username: true, firstName: true, lastName: true,
          grade: true, division: true, divisions: true, rollNo: true, email: true, mobile: true, lastLoginAt: true,
        },
      }),
      prisma.attempt.findMany({
        where: { testId },
        orderBy: { startedAt: 'asc' },
        select: {
          userId: true, status: true, score: true, maxScore: true, percentage: true,
          correctCount: true, incorrectCount: true, unansweredCount: true,
          startedAt: true, submittedAt: true,
        },
      }),
    ]);

    const best = new Map<string, (typeof attempts)[number]>();
    for (const a of attempts) {
      const held = best.get(a.userId);
      if (!held || ATTEMPT_RANK[a.status] > ATTEMPT_RANK[held.status] || (ATTEMPT_RANK[a.status] === ATTEMPT_RANK[held.status] && a.percentage > held.percentage)) {
        best.set(a.userId, a);
      }
    }

    const audience = students
      .filter((s) => inAudience(test, s))
      .map((s) => ({
        student: s as RosterStudent,
        attempt: best.get(s.id) ?? null,
      }));

    return { test, audience };
  }

  function testFilename(test: { publicId: string }, kind: string): string {
    return `${test.publicId}-${kind}.csv`;
  }

  function csvReply(reply: { header: (k: string, v: string) => unknown }, filename: string, body: string) {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** Everyone in the audience who has at least one attempt on this test. */
  app.get('/api/admin/tests/:id/attempts.csv', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = await roster(request, id);
    if (!data) return reply.code(404).send({ error: 'Test not found.' });

    const contacts = maySeeContacts(request);
    const rows = data.audience
      .filter(({ attempt }) => attempt !== null)
      .map(({ student, attempt }) => [
        student.publicId,
        `${student.firstName} ${student.lastName}`,
        student.username,
        `${student.grade}-${student.division}`,
        student.rollNo,
        contacts ? student.email ?? '' : '',
        contacts ? student.mobile ?? '' : '',
        attempt!.status.toLowerCase(),
        attempt!.score,
        attempt!.maxScore,
        attempt!.percentage,
        attempt!.correctCount,
        attempt!.incorrectCount,
        attempt!.unansweredCount,
        attempt!.submittedAt ? attempt!.submittedAt.toISOString() : '',
        attempt!.percentage >= data.test.passPercentage ? 'yes' : 'no',
      ]);

    return csvReply(
      reply,
      testFilename(data.test, 'attempted'),
      csvFile(
        ['user_id', 'name', 'username', 'class', 'roll_no', 'email', 'mobile', 'status', 'score', 'max_score', 'percentage', 'correct', 'wrong', 'skipped', 'submitted_at', 'passed'],
        rows,
      ),
    );
  });

  /** Everyone in the audience with no attempt at all — the list to chase. */
  app.get('/api/admin/tests/:id/non-attempts.csv', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = await roster(request, id);
    if (!data) return reply.code(404).send({ error: 'Test not found.' });

    const contacts = maySeeContacts(request);
    const rows = data.audience
      .filter(({ attempt }) => attempt === null)
      .map(({ student }) => [
        student.publicId,
        `${student.firstName} ${student.lastName}`,
        student.username,
        `${student.grade}-${student.division}`,
        student.rollNo,
        contacts ? student.email ?? '' : '',
        contacts ? student.mobile ?? '' : '',
        student.lastLoginAt ? student.lastLoginAt.toISOString() : '',
      ]);

    return csvReply(
      reply,
      testFilename(data.test, 'not-attempted'),
      csvFile(['user_id', 'name', 'username', 'class', 'roll_no', 'email', 'mobile', 'last_login'], rows),
    );
  });

  /** The results table as a spreadsheet: one row per student who sat it. */
  app.get('/api/admin/tests/:id/results.csv', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = await roster(request, id);
    if (!data) return reply.code(404).send({ error: 'Test not found.' });

    const contacts = maySeeContacts(request);
    const rows = data.audience
      .filter(({ attempt }) => attempt !== null)
      .sort((a, b) => b.attempt!.percentage - a.attempt!.percentage)
      .map(({ student, attempt }) => [
        student.publicId,
        `${student.firstName} ${student.lastName}`,
        student.username,
        `${student.grade}-${student.division}`,
        student.rollNo,
        contacts ? student.email ?? '' : '',
        contacts ? student.mobile ?? '' : '',
        attempt!.status.toLowerCase(),
        attempt!.score,
        attempt!.maxScore,
        attempt!.percentage,
        attempt!.correctCount,
        attempt!.incorrectCount,
        attempt!.unansweredCount,
        attempt!.submittedAt ? attempt!.submittedAt.toISOString() : '',
        attempt!.percentage >= data.test.passPercentage ? 'yes' : 'no',
      ]);

    return csvReply(
      reply,
      testFilename(data.test, 'results'),
      csvFile(
        ['user_id', 'name', 'username', 'class', 'roll_no', 'email', 'mobile', 'status', 'score', 'max_score', 'percentage', 'correct', 'wrong', 'skipped', 'submitted_at', 'passed'],
        rows,
      ),
    );
  });
}
