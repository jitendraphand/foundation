import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent, makePaper, makeQuestion, recordResult } from '../helpers/factories.js';

/**
 * The findings the overview leads with.
 *
 * A screen that states conclusions instead of showing charts is only worth
 * having if the conclusions are right, so every sentence is checked against the
 * data that produced it - including that an empty school says nothing rather
 * than dressing zeroes up as findings.
 */

describe('what needs a teacher\'s attention', { skip: skipWithoutDatabase }, () => {
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

  const briefing = async (adminUser: Parameters<TestApi['as']>[0], query = '?days=3650') => {
    const teacher = await api.as(adminUser);
    const res = await teacher.get(`/api/admin/analytics/briefing${query}`);
    assert.equal(res.status, 200, res.raw.slice(0, 200));
    return res.body.findings as Array<{ id: string; severity: string; headline: string; detail: string; action: { to: string } }>;
  };

  test('a school with no results reports nothing at all', async () => {
    const admin = await makeAdmin(prisma);
    assert.deepEqual(await briefing(admin), []);
  });

  test('children far behind are named, with their averages', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });

    const struggling = await makeStudent(prisma, { firstName: 'Struggling' });
    await recordResult(prisma, { testId: paper.id, userId: struggling.id, percentage: 25 });
    const fine = await makeStudent(prisma, { firstName: 'Fine' });
    await recordResult(prisma, { testId: paper.id, userId: fine.id, percentage: 85 });

    const found = (await briefing(admin)).find((f) => f.id === 'students-behind');
    assert.ok(found, 'expected a finding about children who are behind');
    assert.match(found.headline, /^1 student is averaging under 40%/);
    assert.match(found.detail, /Struggling/);
    assert.doesNotMatch(found.detail, /Fine/, 'a child who is doing well must not be on this list');
    assert.equal(found.severity, 'high');
  });

  test('a child who is slipping is reported even though their average looks fine', async () => {
    // The case an average hides completely, and the reason the trend exists.
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
    const slipping = await makeStudent(prisma, { firstName: 'Slipping' });

    const day = 86_400_000;
    const scores = [95, 90, 88, 60, 55, 50];
    for (const [i, percentage] of scores.entries()) {
      await recordResult(prisma, {
        testId: paper.id, userId: slipping.id, percentage,
        attemptNumber: i + 1, submittedAt: new Date(Date.now() - (scores.length - i) * day),
      });
    }

    const found = (await briefing(admin)).find((f) => f.id === 'students-slipping');
    assert.ok(found, 'expected a finding about children who are slipping');
    assert.match(found.headline, /1 student has dropped 10 points or more/);
    assert.match(found.detail, /Slipping/);
    // Newest three average 55, oldest three 91: a drop of 36.
    assert.match(found.detail, /-36/);
  });

  test('the weakest skill is the one most children are below, not the lowest percentage', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });

    // Eight children are poor at fractions; one child is worse at mensuration,
    // but one child is not a class.
    for (let i = 0; i < 8; i++) {
      const s = await makeStudent(prisma, { firstName: `Child${i}` });
      await recordResult(prisma, {
        testId: paper.id, userId: s.id, percentage: 55,
        skills: { fraction_operations: { correct: 2, total: 10 } },
      });
    }
    const outlier = await makeStudent(prisma, { firstName: 'Outlier' });
    await recordResult(prisma, {
      testId: paper.id, userId: outlier.id, percentage: 55,
      skills: { mensuration: { correct: 0, total: 10 } },
    });

    const found = (await briefing(admin)).find((f) => f.id === 'weak-skill');
    assert.ok(found);
    assert.match(found.headline, /8 students are below 60% on fraction operations/);
    assert.match(found.action.to, /axis=skill/);
    assert.match(found.action.to, /key=fraction_operations/);
  });

  test('a question almost nobody answered correctly is flagged, and blamed on the wording', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
    const dud = await makeQuestion(prisma, admin.id, { text: 'Which of these is the odd one out?' });
    await prisma.testQuestion.create({ data: { testId: paper.id, questionId: dud.id, position: 1, marks: 1 } });

    for (let i = 0; i < 12; i++) {
      const s = await makeStudent(prisma, { firstName: `C${i}` });
      const attempt = await recordResult(prisma, { testId: paper.id, userId: s.id, percentage: 0 });
      await prisma.answer.create({
        data: { attemptId: attempt.id, questionId: dud.id, response: { optionId: 'a' }, isCorrect: false },
      });
    }

    const found = (await briefing(admin)).find((f) => f.id === 'suspect-questions');
    assert.ok(found);
    assert.match(found.headline, /1 question was answered correctly by fewer than 1 in 5/);
    assert.match(found.detail, /0 of 12 correct/);
    assert.match(found.detail, /odd one out/, 'enough of the question to recognise it');
    assert.match(found.detail, /wording or the answer key/, 'the child is not the suspect');
  });

  test('papers whose marks nobody has released are reported', async () => {
    const admin = await makeAdmin(prisma);
    const { test: held } = await makePaper(prisma, admin.id, {
      questions: 1, resultsReleased: false, title: 'Held-back paper',
    });
    for (let i = 0; i < 5; i++) {
      const s = await makeStudent(prisma);
      await recordResult(prisma, { testId: held.id, userId: s.id, percentage: 70 });
    }

    const found = (await briefing(admin)).find((f) => f.id === 'unreleased-results');
    assert.ok(found);
    assert.match(found.headline, /1 paper has marks nobody can see yet/);
    assert.match(found.detail, /5 submitted papers/);
    assert.match(found.detail, /Held-back paper/);
  });

  test('questions waiting for review are reported, with the real count', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
    const student = await makeStudent(prisma);
    await recordResult(prisma, { testId: paper.id, userId: student.id, percentage: 70 });

    for (let i = 0; i < 3; i++) {
      const q = await makeQuestion(prisma, admin.id);
      await prisma.question.update({ where: { id: q.id }, data: { status: 'DRAFT' } });
    }

    const found = (await briefing(admin)).find((f) => f.id === 'unreviewed-questions');
    assert.ok(found);
    assert.match(found.headline, /^3 generated questions are waiting for review/);
    assert.equal(found.severity, 'low');
  });

  test('the urgent findings come first', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
    const behind = await makeStudent(prisma, { firstName: 'Behind' });
    await recordResult(prisma, { testId: paper.id, userId: behind.id, percentage: 10 });
    const draft = await makeQuestion(prisma, admin.id);
    await prisma.question.update({ where: { id: draft.id }, data: { status: 'DRAFT' } });

    const findings = await briefing(admin);
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const order = findings.map((f) => rank[f.severity]);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test('every finding carries a number and somewhere to go', async () => {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
    const s = await makeStudent(prisma, { firstName: 'Someone' });
    await recordResult(prisma, { testId: paper.id, userId: s.id, percentage: 15 });

    const findings = await briefing(admin);
    assert.ok(findings.length > 0);
    for (const f of findings) {
      assert.match(f.headline, /\d/, `"${f.headline}" has no number in it`);
      assert.ok(f.action.to.startsWith('/admin'), `"${f.headline}" leads nowhere`);
      assert.ok(f.detail.length > 0);
    }
  });
});
