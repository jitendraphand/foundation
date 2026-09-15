import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent, makePaper } from '../helpers/factories.js';

/**
 * Deleting a student's attempt.
 *
 * A mistaken submission, or a retake the teacher wants to allow, must be
 * erasable per student without touching anyone else's results. The route lives
 * behind `tests.manage` and the same per-test visibility as everything else, so
 * one colleague cannot wipe another's paper.
 */

describe('an administrator deleting a student attempt', { skip: skipWithoutDatabase }, () => {
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

  test('removes the attempt and its answers', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 3 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/submit`);
    const attemptId = started.attemptId;

    assert.equal(await prisma.answer.count({ where: { attemptId } }), 3);
    assert.equal(await prisma.attempt.count({ where: { id: attemptId } }), 1);

    const res = await (await api.as(admin)).del(`/api/admin/attempts/${attemptId}`);
    assert.equal(res.status, 200);
    assert.equal(await prisma.answer.count({ where: { attemptId } }), 0);
    assert.equal(await prisma.attempt.count({ where: { id: attemptId } }), 0);
  });

  test('decrements the live difficulty counters it had counted', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    // Answer both correctly so they count, then submit.
    for (const q of questions) {
      await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
        questionId: q.id, response: { optionId: 'b' },
      });
    }
    await child.post(`/api/student/attempts/${started.attemptId}/submit`);

    const servedBefore = await prisma.question.findMany({
      where: { id: { in: questions.map((q) => q.id) } },
      select: { id: true, timesServed: true, timesCorrect: true },
    });
    assert.ok(servedBefore.every((q) => q.timesServed === 1), 'each answered question counted once');
    assert.ok(servedBefore.every((q) => q.timesCorrect === 1), 'each was correct');

    const res = await (await api.as(admin)).del(`/api/admin/attempts/${started.attemptId}`);
    assert.equal(res.status, 200);

    const servedAfter = await prisma.question.findMany({
      where: { id: { in: questions.map((q) => q.id) } },
      select: { id: true, timesServed: true, timesCorrect: true },
    });
    assert.ok(servedAfter.every((q) => q.timesServed === 0), 'the paper no longer counts towards difficulty');
    assert.ok(servedAfter.every((q) => q.timesCorrect === 0));
  });

  test('is refused for an administrator who cannot see the test', async () => {
    const admin = await makeAdmin(prisma);
    const intruder = await makeAdmin(prisma, ['tests.manage']);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);

    const res = await (await api.as(intruder)).del(`/api/admin/attempts/${started.attemptId}`);
    assert.equal(res.status, 404);
    assert.equal(await prisma.attempt.count({ where: { id: started.attemptId } }), 1, 'the attempt survives');
  });

  test('needs tests.manage at all', async () => {
    const admin = await makeAdmin(prisma, ['questions.review']);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);

    const res = await (await api.as(admin)).del(`/api/admin/attempts/${started.attemptId}`);
    assert.equal(res.status, 403);
  });

  test('a missing attempt is a clean 404', async () => {
    const admin = await makeAdmin(prisma);
    const res = await (await api.as(admin)).del(`/api/admin/attempts/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
  });
});
