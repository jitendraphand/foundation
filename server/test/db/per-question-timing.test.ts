import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent, makePaper } from '../helpers/factories.js';

/**
 * Per-question timing, when a test opts in.
 *
 * The clock starts at the student's first save on that question — server-seen,
 * not client-claimed — and after it runs out, further saves are refused. What
 * was saved in time still counts; the paper's own deadline is unaffected.
 * A test that never opts in keeps the old behaviour: save whenever.
 */

describe('per-question timing', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let api: TestApi;

  before(async () => {
    prisma = await testDatabase();
    api = await testApi(prisma);
  });
  after(async () => {
    await api.close();
    await closeDatabase();
  });
  beforeEach(async () => { await resetDatabase(prisma); });

  /** Shrink a question's first-seen into the past, simulating elapsed time. */
  async function ageFirstSeen(attemptId: string, questionId: string, secondsAgo: number) {
    const answer = await prisma.answer.findUniqueOrThrow({
      where: { attemptId_questionId: { attemptId, questionId } },
    });
    const meta = (answer.meta ?? {}) as { firstSeenAt?: string };
    await prisma.answer.update({
      where: { id: answer.id },
      data: { meta: { ...meta, firstSeenAt: new Date(Date.now() - secondsAgo * 1000).toISOString() } },
    });
  }

  test('enforced test: save in time counts, save after is refused', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });
    await prisma.test.update({ where: { id: paper.id }, data: { meta: { perQuestionTiming: true } } });
    await prisma.testQuestion.updateMany({ where: { testId: paper.id }, data: { timeLimitSeconds: 60 } });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);

    // First save starts the clock and is accepted.
    const ok1 = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'b' },
    });
    assert.equal(ok1.status, 200);

    // Clock still running: a second save is accepted.
    const ok2 = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'a' },
    });
    assert.equal(ok2.status, 200);

    // Simulate the limit elapsing.
    await ageFirstSeen(started.attemptId, questions[0].id, 61);

    const late = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'c' },
    });
    assert.equal(late.status, 409);
    assert.equal((late.body as { code: string }).code, 'QUESTION_TIME_UP');

    // The in-time answer still stands (option 'a', not the refused 'c').
    const stored = await prisma.answer.findUniqueOrThrow({
      where: { attemptId_questionId: { attemptId: started.attemptId, questionId: questions[0].id } },
    });
    assert.deepEqual(stored.response, { optionId: 'a' });

    // The other question is unaffected — its clock has not started.
    const other = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[1].id, response: { optionId: 'b' },
    });
    assert.equal(other.status, 200);
  });

  test('skip-and-return does not buy time: the clock keeps running', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });
    await prisma.test.update({ where: { id: paper.id }, data: { meta: { perQuestionTiming: true } } });
    await prisma.testQuestion.updateMany({ where: { testId: paper.id }, data: { timeLimitSeconds: 60 } });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);

    // Answer Q1 (clock starts), wait, then return to Q1 long after.
    await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'b' },
    });
    await ageFirstSeen(started.attemptId, questions[0].id, 300);

    const back = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'a' },
    });
    assert.equal(back.status, 409);
  });

  test('a test that never opts in keeps the old behaviour', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 1 });
    // No perQuestionTiming in meta; limits exist on the rows but are ignored.

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'b' },
    });
    await ageFirstSeen(started.attemptId, questions[0].id, 3600);

    const anytime = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'a' },
    });
    assert.equal(anytime.status, 200, 'no toggle, no cutoff');
  });

  test('the toggle is settable at creation and editable after', async () => {
    const admin = await makeAdmin(prisma);
    const call = await api.as(admin);

    const created = await call.post('/api/admin/tests', {
      title: 'Timed drill', subject: 'Mathematics', kind: 'REGULAR',
      durationMinutes: 10, perQuestionTiming: true,
    });
    assert.equal(created.status, 201);
    const testId = (created.body as { test: { id: string } }).test.id;
    assert.equal(
      ((await prisma.test.findUniqueOrThrow({ where: { id: testId } })).meta as { perQuestionTiming?: boolean })
        .perQuestionTiming,
      true,
    );

    // Turned off afterwards through the same rules card.
    const patched = await call.patch(`/api/admin/tests/${testId}`, { perQuestionTiming: false });
    assert.equal(patched.status, 200);
    assert.equal(
      ((await prisma.test.findUniqueOrThrow({ where: { id: testId } })).meta as { perQuestionTiming?: boolean })
        .perQuestionTiming,
      false,
    );
  });

  test('the live paper only exposes limits when the test enforces them', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });
    await prisma.testQuestion.updateMany({ where: { testId: paper.id }, data: { timeLimitSeconds: 60 } });

    // Not enforced: no pacing leaks to the client.
    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    const hidden = await child.get(`/api/student/attempts/${started.attemptId}`);
    assert.equal((hidden.body as { test: { perQuestionTiming?: boolean } }).test.perQuestionTiming, false);
    for (const q of hidden.body.questions as Array<{ timeLimitSeconds?: number }>) {
      assert.equal(q.timeLimitSeconds, undefined);
    }

    // Enforced: the runner can render the countdown.
    await prisma.test.update({ where: { id: paper.id }, data: { meta: { perQuestionTiming: true } } });
    const shown = await child.get(`/api/student/attempts/${started.attemptId}`);
    assert.equal((shown.body as { test: { perQuestionTiming?: boolean } }).test.perQuestionTiming, true);
    for (const q of shown.body.questions as Array<{ timeLimitSeconds?: number; firstSeenAt?: string | null }>) {
      assert.equal(q.timeLimitSeconds, 60);
      assert.equal(q.firstSeenAt, null);
    }
  });
});
