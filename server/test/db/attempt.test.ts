import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { makeAdmin, makeStudent, makePaper, startAttempt, answerAll } from '../helpers/factories.js';

/**
 * Grading a paper, and grading it exactly once.
 *
 * finalizeAttempt is reachable from five places - submit, the timer, the tick,
 * loading a paper, and the expiry sweep - and the sweep runs on every student
 * dashboard load. So the same attempt really is finalised by several requests
 * within milliseconds of each other during a class, and this file exists
 * because that used to count the paper once per request.
 */

describe('finalising an attempt', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let finalizeAttempt: typeof import('../../src/services/attempt.js').finalizeAttempt;

  before(async () => {
    prisma = await testDatabase();
    // Imported after the database exists so the client picks up the test URL.
    ({ finalizeAttempt } = await import('../../src/services/attempt.js'));
  });
  after(async () => { await closeDatabase(); });
  beforeEach(async () => { await resetDatabase(prisma); });

  test('a paper sat once is counted once, however many callers arrive together', async () => {
    // The regression this guards: six open dashboards meant timesServed went up
    // by six on every question, so observedP - the figure a teacher uses to
    // spot a badly worded question - was wrong by that factor.
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 5 });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, {
      testId: paper.id, userId: student.id, questionIds: ids,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await answerAll(prisma, attempt.id, ids, () => true);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => finalizeAttempt(attempt.id, true)),
    );
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0, 'no caller should error');

    const after = await prisma.question.findMany({ where: { id: { in: ids } } });
    for (const q of after) {
      assert.equal(q.timesServed, 1, `${q.id} was served ${q.timesServed} times for one sitting`);
      assert.equal(q.timesCorrect, 1);
    }
  });

  test('and it is still graded correctly under that contention', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 4 });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, { testId: paper.id, userId: student.id, questionIds: ids });
    // Three right, one wrong.
    await answerAll(prisma, attempt.id, ids, (i) => i < 3);

    await Promise.all(Array.from({ length: 6 }, () => finalizeAttempt(attempt.id, false)));

    const graded = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(graded.status, 'SUBMITTED');
    assert.equal(graded.score, 3);
    assert.equal(graded.maxScore, 4);
    assert.equal(graded.correctCount, 3);
    assert.equal(graded.incorrectCount, 1);
    assert.equal(graded.percentage, 75);
  });

  test('finalising an already-submitted attempt returns the stored result', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, { testId: paper.id, userId: student.id, questionIds: ids });
    await answerAll(prisma, attempt.id, ids, () => true);

    const first = await finalizeAttempt(attempt.id, false);
    const second = await finalizeAttempt(attempt.id, false);
    assert.equal(second.score, first.score);
    assert.equal(second.submittedAt?.getTime(), first.submittedAt?.getTime(), 'the submission time must not move');

    const q = await prisma.question.findUniqueOrThrow({ where: { id: ids[0] } });
    assert.equal(q.timesServed, 1);
  });

  test('an unanswered question is not counted as served', async () => {
    // Statistics are about questions students attempted. A blank tells you
    // nothing about the question, and counting it would drag observedP down.
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 3 });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, { testId: paper.id, userId: student.id, questionIds: ids });
    await answerAll(prisma, attempt.id, [ids[0]], () => true);

    await finalizeAttempt(attempt.id, false);

    const [answered, blank] = await Promise.all([
      prisma.question.findUniqueOrThrow({ where: { id: ids[0] } }),
      prisma.question.findUniqueOrThrow({ where: { id: ids[1] } }),
    ]);
    assert.equal(answered.timesServed, 1);
    assert.equal(blank.timesServed, 0);

    const graded = await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(graded.unansweredCount, 2);
  });

  test('negative marking never takes a paper below zero', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 3, negativeMarks: 1 });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, { testId: paper.id, userId: student.id, questionIds: ids });
    await answerAll(prisma, attempt.id, ids, () => false);

    const graded = await finalizeAttempt(attempt.id, false);
    assert.equal(graded.score, 0, 'a child cannot owe the school marks');
    assert.equal(graded.percentage, 0);
  });

  test('the breakdown records the axes the questions were tagged with', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, {
      questions: 4, skills: ['fraction_operations'],
    });
    const ids = questions.map((q) => q.id);

    const attempt = await startAttempt(prisma, { testId: paper.id, userId: student.id, questionIds: ids });
    await answerAll(prisma, attempt.id, ids, (i) => i < 3);
    const graded = await finalizeAttempt(attempt.id, false);

    const breakdown = graded.breakdown as { bySkill: Record<string, { correct: number; total: number }> };
    assert.equal(breakdown.bySkill.fraction_operations.correct, 3);
    assert.equal(breakdown.bySkill.fraction_operations.total, 4);
  });

  test('a whole class submitting together is graded correctly, all of it', async () => {
    // Not a benchmark - the batching this covers replaced one UPDATE per answer
    // with one per paper, and the risk of that change is a row not updated.
    const admin = await makeAdmin(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 6 });
    const ids = questions.map((q) => q.id);

    const students = [];
    for (let i = 0; i < 12; i++) students.push(await makeStudent(prisma, { firstName: `Child${i}` }));

    const attempts = [];
    for (const s of students) {
      const a = await startAttempt(prisma, { testId: paper.id, userId: s.id, questionIds: ids });
      await answerAll(prisma, a.id, ids, (qi) => qi % 2 === 0);
      attempts.push(a);
    }

    await Promise.all(attempts.map((a) => finalizeAttempt(a.id, false)));

    const graded = await prisma.attempt.findMany({ where: { testId: paper.id } });
    assert.equal(graded.length, 12);
    for (const a of graded) {
      assert.equal(a.status, 'SUBMITTED');
      assert.equal(a.score, 3, 'three of six right');
      assert.equal(a.percentage, 50);
    }

    // Every answer row carries its mark, which is what the batched UPDATE had
    // to get right for all of them rather than for the first.
    const answers = await prisma.answer.findMany({ where: { attempt: { testId: paper.id } } });
    assert.equal(answers.length, 72);
    assert.ok(answers.every((a) => a.isCorrect !== null), 'every answer should have been graded');

    for (const q of await prisma.question.findMany({ where: { id: { in: ids } } })) {
      assert.equal(q.timesServed, 12, 'twelve children sat it, once each');
    }
  });
});
