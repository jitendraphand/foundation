import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, anonymous, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent, makePaper } from '../helpers/factories.js';

/**
 * What a student is allowed to see, enforced by the routes themselves.
 *
 * The single most damaging thing this system could do is hand a child the
 * answer key with the paper. That is a property of the *reply*, not of a
 * function, so it is checked here on the real route through the real hooks.
 */

describe('sitting a paper', { skip: skipWithoutDatabase }, () => {
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

  test('an answer key never reaches the student', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 3 });

    const child = await api.as(student);
    const started = await child.post(`/api/student/tests/${paper.id}/start`);
    assert.equal(started.status, 200);

    const live = await child.get(`/api/student/attempts/${started.body.attemptId}`);
    assert.equal(live.status, 200);
    assert.equal(live.body.questions.length, 3);

    // Checked on the serialised reply, not on the parsed object: a key nested
    // anywhere in it is still a key on the wire.
    assert.doesNotMatch(live.raw, /answerKey/, 'the answer key is in the reply');
    assert.doesNotMatch(live.raw, /correctOptionId/, 'the correct option is in the reply');
    assert.doesNotMatch(live.raw, /explanation/, 'the explanation is in the reply');
    for (const q of live.body.questions) {
      assert.equal(q.answerKey, undefined);
      assert.equal(q.explanation, undefined);
    }
  });

  test('a mark is held back until the teacher releases it', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2, resultsReleased: false });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    for (const q of questions) {
      await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
        questionId: q.id, response: { optionId: 'b' },
      });
    }
    const submitted = await child.post(`/api/student/attempts/${started.attemptId}/submit`);
    assert.equal(submitted.status, 200);

    const result = await child.get(`/api/student/attempts/${started.attemptId}/result`);
    assert.equal(result.body.released, false);
    assert.doesNotMatch(result.raw, /"percentage"/, 'the score leaked before release');
    assert.doesNotMatch(result.raw, /correctOptionId/);

    await prisma.test.update({ where: { id: paper.id }, data: { resultsReleased: true } });

    const afterRelease = await child.get(`/api/student/attempts/${started.attemptId}/result`);
    assert.equal(afterRelease.body.released, true);
    assert.equal(afterRelease.body.attempt.percentage, 100);
  });

  test('one student cannot open another student\'s attempt', async () => {
    const admin = await makeAdmin(prisma);
    const mine = await makeStudent(prisma, { firstName: 'Mine' });
    const theirs = await makeStudent(prisma, { firstName: 'Theirs' });
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const owner = await api.as(mine);
    const { body: started } = await owner.post(`/api/student/tests/${paper.id}/start`);

    const intruder = await api.as(theirs);
    const peek = await intruder.get(`/api/student/attempts/${started.attemptId}`);
    assert.equal(peek.status, 404, 'and 404 rather than 403, so it does not confirm the attempt exists');

    const write = await intruder.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: '00000000-0000-0000-0000-000000000000', response: { optionId: 'a' },
    });
    assert.ok(write.status >= 400);
  });

  test('a student cannot reach the admin side at all', async () => {
    const student = await makeStudent(prisma);
    const child = await api.as(student);
    for (const url of [
      '/api/admin/analytics/overview',
      '/api/admin/analytics/briefing',
      '/api/admin/questions',
      '/api/admin/credentials',
    ]) {
      const res = await child.get(url);
      assert.ok(res.status === 401 || res.status === 403, `${url} returned ${res.status}`);
    }
  });

  test('an administrator only reaches the areas they were granted', async () => {
    // The ADMIN role on its own grants nothing; every area is gated on a
    // specific privilege, so a colleague given only the question bank cannot
    // read the analytics or change the API keys.
    const limited = await makeAdmin(prisma, ['questions.review']);
    const partial = await api.as(limited);

    assert.equal((await partial.get('/api/admin/questions')).status, 200);
    assert.equal((await partial.get('/api/admin/analytics/overview')).status, 403);
    assert.equal((await partial.get('/api/admin/credentials')).status, 403);
  });

  test('and neither can somebody who is not signed in', async () => {
    const guest = anonymous(api.app);
    for (const url of ['/api/student/dashboard', '/api/admin/analytics/overview']) {
      assert.equal((await guest.get(url)).status, 401);
    }
  });

  test('an answer for a question not on the paper is refused', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });
    const elsewhere = await makePaper(prisma, admin.id, { questions: 1 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    const res = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: elsewhere.questions[0].id, response: { optionId: 'b' },
    });
    assert.equal(res.status, 400);
  });

  test('an option that does not exist is refused', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 1 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    const res = await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'zzz' },
    });
    assert.equal(res.status, 400);
  });

  test('submitting twice says so calmly and changes nothing', async () => {
    // Deliberately not an error. A double-click, or a retry over a dropped
    // connection, happens constantly on a phone in an exam hall, and showing a
    // child a failure at that moment would be worse than useless. What must not
    // happen is a second grading.
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
      questionId: questions[0].id, response: { optionId: 'b' },
    });

    const first = await child.post(`/api/student/attempts/${started.attemptId}/submit`);
    assert.equal(first.status, 200);

    const before = await prisma.attempt.findUniqueOrThrow({ where: { id: started.attemptId } });

    const second = await child.post(`/api/student/attempts/${started.attemptId}/submit`);
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadySubmitted, true);

    const after = await prisma.attempt.findUniqueOrThrow({ where: { id: started.attemptId } });
    assert.equal(after.score, before.score);
    assert.equal(after.submittedAt?.getTime(), before.submittedAt?.getTime());

    const q = await prisma.question.findUniqueOrThrow({ where: { id: questions[0].id } });
    assert.equal(q.timesServed, 1, 'the second submit must not count the paper again');
  });

  test('a paper set for another class is refused', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma, { grade: 'Grade 8' });
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1, targetGrades: ['Grade 10'] });

    const child = await api.as(student);
    assert.equal((await child.post(`/api/student/tests/${paper.id}/start`)).status, 403);
  });

  test('starting twice resumes the same attempt rather than making a second', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(student);
    const first = await child.post(`/api/student/tests/${paper.id}/start`);
    const second = await child.post(`/api/student/tests/${paper.id}/start`);

    assert.equal(second.body.attemptId, first.body.attemptId);
    assert.equal(second.body.resumed, true);
    assert.equal(await prisma.attempt.count({ where: { testId: paper.id } }), 1);
  });

  test('a question retired after publishing is not served into a new attempt', async () => {
    const admin = await makeAdmin(prisma);
    const student = await makeStudent(prisma);
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 3 });

    await prisma.question.update({ where: { id: questions[0].id }, data: { deletedAt: new Date() } });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    const live = await child.get(`/api/student/attempts/${started.attemptId}`);

    assert.equal(live.body.questions.length, 2);
    assert.ok(!live.body.questions.some((q: { id: string }) => q.id === questions[0].id));
  });
});
