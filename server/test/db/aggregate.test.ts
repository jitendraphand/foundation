import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { makeAdmin, makeStudent, makePaper, recordResult } from '../helpers/factories.js';

/**
 * The analytics figures, which the database now computes.
 *
 * These used to be folded together in JavaScript, and were moved into SQL
 * because doing it in Node cost seconds of blocked event loop on a single
 * process - taken from the children sitting a paper at the time. The risk of
 * that move is that the numbers quietly change, so every figure here is checked
 * against one worked out by hand in the test.
 */

describe('counting in the database', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let agg: typeof import('../../src/lib/aggregate.js');

  before(async () => {
    prisma = await testDatabase();
    agg = await import('../../src/lib/aggregate.js');
  });
  after(async () => { await closeDatabase(); });
  beforeEach(async () => { await resetDatabase(prisma); });

  /** Four children, one paper, scores chosen so every statistic is checkable. */
  async function aClassWithResults() {
    const admin = await makeAdmin(prisma);
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 1, resultsReleased: true });

    const scores = [30, 50, 70, 90];
    const students = [];
    for (const [i, percentage] of scores.entries()) {
      const student = await makeStudent(prisma, { firstName: `Child${i}`, grade: 'Grade 8' });
      await recordResult(prisma, {
        testId: paper.id, userId: student.id, percentage,
        skills: { fraction_operations: { correct: i, total: 4 } },
      });
      students.push(student);
    }
    return { admin, paper, students, scores };
  }

  describe('the headline figures', () => {
    test('mean, median and pass rate are what they should be', async () => {
      await aClassWithResults();
      const stats = await agg.headline({ kind: 'REGULAR' });

      assert.equal(stats.attempts, 4);
      assert.equal(stats.students, 4);
      assert.equal(stats.average, 60, '(30+50+70+90)/4');
      assert.equal(stats.median, 60, 'the mean of the middle two');
      // The pass mark on the factory paper is 40, so three of four are over it.
      assert.equal(stats.passRate, 75);
    });

    test('the median is not the mean, when the two differ', async () => {
      // The reason the median is shown at all: one child on 4% moves the
      // average in a way that misrepresents the class.
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      for (const percentage of [4, 80, 82, 84, 86]) {
        const s = await makeStudent(prisma);
        await recordResult(prisma, { testId: paper.id, userId: s.id, percentage });
      }
      const stats = await agg.headline({ kind: 'REGULAR' });
      assert.equal(stats.median, 82);
      assert.ok(stats.average < stats.median - 10, 'the mean should be dragged well below the median');
    });

    test('the histogram puts each score in its own band', async () => {
      await aClassWithResults();
      const stats = await agg.headline({ kind: 'REGULAR' });
      const counts = stats.distribution.map((d) => d.count);
      // 30, 50, 70, 90 -> bands 3, 5, 7, 9.
      assert.deepEqual(counts, [0, 0, 0, 1, 0, 1, 0, 1, 0, 1]);
    });

    test('an empty school reports zeroes rather than failing', async () => {
      const stats = await agg.headline({ kind: 'REGULAR' });
      assert.equal(stats.attempts, 0);
      assert.equal(stats.average, 0);
      assert.equal(stats.passRate, 0);
      assert.equal(stats.distribution.length, 10);
    });
  });

  describe('tag mastery', () => {
    test('a skill is summed across every child and paper', async () => {
      await aClassWithResults();
      const mastery = await agg.tagTallies({ kind: 'REGULAR' });
      // correct was 0,1,2,3 out of 4 each.
      assert.equal(mastery.bySkill.fraction_operations.correct, 6);
      assert.equal(mastery.bySkill.fraction_operations.total, 16);
      assert.equal(mastery.bySkill.fraction_operations.accuracy, 0.38);
    });

    test('only the axes asked for are queried', async () => {
      await aClassWithResults();
      const mastery = await agg.tagTallies({ kind: 'REGULAR' }, ['skill']);
      assert.ok(Object.keys(mastery.bySkill).length > 0);
      assert.deepEqual(Object.keys(mastery.byDifficulty), []);
    });
  });

  describe('the ranked student table', () => {
    test('one row per child who sat something, weakest first', async () => {
      const { students } = await aClassWithResults();
      const rows = await agg.studentRows({ kind: 'REGULAR' }, 1);

      assert.equal(rows.length, 4);
      assert.equal(rows[0].averagePercentage, 30, 'the child who needs help is at the top');
      assert.equal(rows[3].averagePercentage, 90);
      assert.ok(rows.every((r) => students.some((s) => s.id === r.id)));
    });

    test('a child who sat nothing is not in the table at all', async () => {
      await aClassWithResults();
      await makeStudent(prisma, { firstName: 'Newcomer' });
      const rows = await agg.studentRows({ kind: 'REGULAR' }, 1);
      assert.equal(rows.length, 4);
      assert.ok(!rows.some((r) => r.name.includes('Newcomer')));
    });

    test('the trend compares the newest three papers with the oldest three', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const student = await makeStudent(prisma);

      // Six sittings, falling from 90 to 30: newest three average 40, oldest
      // three average 80, so the trend is -40.
      const day = 86_400_000;
      const scores = [90, 85, 65, 45, 40, 35];
      for (const [i, percentage] of scores.entries()) {
        await recordResult(prisma, {
          testId: paper.id, userId: student.id, percentage,
          attemptNumber: i + 1, submittedAt: new Date(Date.now() - (scores.length - i) * day),
        });
      }

      const [row] = await agg.studentRows({ kind: 'REGULAR' }, 1);
      assert.equal(row.attempts, 6);
      assert.equal(row.trend, -40);
      assert.equal(row.lastPercentage, 35, 'the newest, not the best');
      assert.equal(row.bestPercentage, 90);
    });

    test('too few papers means no trend rather than a made-up one', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const student = await makeStudent(prisma);
      await recordResult(prisma, { testId: paper.id, userId: student.id, percentage: 20 });

      const [row] = await agg.studentRows({ kind: 'REGULAR' }, 1);
      assert.equal(row.trend, 0);
    });
  });

  describe('one skill, down the column', () => {
    test('each child\'s tally on that skill is summed across papers', async () => {
      const admin = await makeAdmin(prisma);
      const { test: first } = await makePaper(prisma, admin.id, { questions: 1, title: 'First' });
      const { test: second } = await makePaper(prisma, admin.id, { questions: 1, title: 'Second' });
      const student = await makeStudent(prisma, { firstName: 'Split' });

      await recordResult(prisma, {
        testId: first.id, userId: student.id, percentage: 40,
        skills: { fraction_operations: { correct: 1, total: 5 } },
      });
      await recordResult(prisma, {
        testId: second.id, userId: student.id, percentage: 60,
        skills: { fraction_operations: { correct: 3, total: 5 } },
      });

      const [row] = await agg.studentsOnTag({ kind: 'REGULAR' }, 'skill', 'fraction_operations');
      assert.equal(row.correct, 4);
      assert.equal(row.total, 10);
      assert.equal(row.papers, 2);

      const papers = await agg.paperTallies({ kind: 'REGULAR' }, 'skill', 'fraction_operations');
      assert.deepEqual(papers.map((p) => p.title).sort(), ['First', 'Second']);
    });

    test('the count of children below the line uses the exact ratio, not the rounded one', async () => {
      // The bug this guards: accuracy was rounded to two places before being
      // compared with the threshold, so a child on 59.74% was not "below 60%"
      // and was missing from the list a teacher works down.
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });

      const justBelow = await makeStudent(prisma, { firstName: 'JustBelow' });
      await recordResult(prisma, {
        testId: paper.id, userId: justBelow.id, percentage: 60,
        // 233/390 = 0.59744..., which rounds to 0.60.
        skills: { fraction_operations: { correct: 233, total: 390 } },
      });

      const summaries = await agg.tagSummaries({ kind: 'REGULAR' }, 'skill', 0.6, 4);
      const row = summaries.find((s) => s.key === 'fraction_operations');
      assert.equal(row?.weak, 1, 'a child on 59.74% is below 60%');
    });

    test('a child with too few questions is reported but not counted as weak', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const thin = await makeStudent(prisma, { firstName: 'Thin' });
      await recordResult(prisma, {
        testId: paper.id, userId: thin.id, percentage: 0,
        skills: { fraction_operations: { correct: 0, total: 2 } },
      });

      const summaries = await agg.tagSummaries({ kind: 'REGULAR' }, 'skill', 0.6, 4);
      const row = summaries.find((s) => s.key === 'fraction_operations');
      assert.equal(row?.students, 1, 'they are still on the list');
      assert.equal(row?.weak, 0, 'but 0 of 2 is not evidence of a weakness');
    });
  });

  describe('what the filters exclude', () => {
    test('practice results never inflate class figures', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const student = await makeStudent(prisma);
      await recordResult(prisma, { testId: paper.id, userId: student.id, percentage: 50 });

      const practice = await prisma.test.create({
        data: {
          title: 'Practice', subject: 'Mathematics', kind: 'PRACTICE', status: 'PUBLISHED',
          resultsReleased: true, durationMinutes: 20, marksPerQuestion: 1, maxAttempts: 5,
          passPercentage: 40, createdById: admin.id, targetUserId: student.id,
        },
      });
      await recordResult(prisma, { testId: practice.id, userId: student.id, percentage: 100 });

      assert.equal((await agg.headline({ kind: 'REGULAR' })).average, 50);
      assert.equal((await agg.headline({ kind: 'PRACTICE' })).average, 100);
      assert.equal((await agg.headline({ kind: 'ALL' })).average, 75);
    });

    test('a deleted child leaves the figures', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const staying = await makeStudent(prisma);
      const leaving = await makeStudent(prisma);
      await recordResult(prisma, { testId: paper.id, userId: staying.id, percentage: 80 });
      await recordResult(prisma, { testId: paper.id, userId: leaving.id, percentage: 20 });

      assert.equal((await agg.headline({ kind: 'REGULAR' })).average, 50);
      await prisma.user.update({ where: { id: leaving.id }, data: { deletedAt: new Date() } });
      assert.equal((await agg.headline({ kind: 'REGULAR' })).average, 80);
    });

    test('a student can be shown only results their teacher has released', async () => {
      // The student dashboard reads its weak areas through this filter, so an
      // unreleased mark must not leak through a summary either.
      const admin = await makeAdmin(prisma);
      const { test: released } = await makePaper(prisma, admin.id, { questions: 1, resultsReleased: true });
      const { test: held } = await makePaper(prisma, admin.id, { questions: 1, resultsReleased: false });
      const student = await makeStudent(prisma);

      await recordResult(prisma, {
        testId: released.id, userId: student.id, percentage: 50,
        skills: { fraction_operations: { correct: 1, total: 2 } },
      });
      await recordResult(prisma, {
        testId: held.id, userId: student.id, percentage: 90,
        skills: { mensuration: { correct: 9, total: 10 } },
      });

      const theirs = await agg.tagTallies({ kind: 'ALL', userId: student.id, releasedOnly: true });
      assert.ok(theirs.bySkill.fraction_operations, 'the released paper counts');
      assert.equal(theirs.bySkill.mensuration, undefined, 'the held-back one does not');

      const teachers = await agg.tagTallies({ kind: 'ALL', userId: student.id });
      assert.ok(teachers.bySkill.mensuration, 'the teacher still sees everything');
    });

    test('grade and division narrow the figures', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper } = await makePaper(prisma, admin.id, { questions: 1 });
      const eight = await makeStudent(prisma, { grade: 'Grade 8', division: 'SCIENCE' });
      const nine = await makeStudent(prisma, { grade: 'Grade 9', division: 'SPORTS' });
      await recordResult(prisma, { testId: paper.id, userId: eight.id, percentage: 40 });
      await recordResult(prisma, { testId: paper.id, userId: nine.id, percentage: 80 });

      assert.equal((await agg.headline({ kind: 'REGULAR', grade: 'Grade 8' })).average, 40);
      assert.equal((await agg.headline({ kind: 'REGULAR', division: 'SPORTS' })).average, 80);
    });
  });

  describe('questions the class found hardest', () => {
    test('a question almost nobody answered correctly rises to the top', async () => {
      const admin = await makeAdmin(prisma);
      const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });
      const [easy, dud] = questions;

      // Twelve children: all get the first right, none get the second.
      for (let i = 0; i < 12; i++) {
        const student = await makeStudent(prisma, { firstName: `C${i}` });
        const attempt = await recordResult(prisma, { testId: paper.id, userId: student.id, percentage: 50 });
        await prisma.answer.createMany({
          data: [
            { attemptId: attempt.id, questionId: easy.id, response: { optionId: 'b' }, isCorrect: true },
            { attemptId: attempt.id, questionId: dud.id, response: { optionId: 'a' }, isCorrect: false },
          ],
        });
      }

      const hardest = await agg.hardestQuestions({ kind: 'REGULAR' }, 5);
      assert.equal(hardest[0].id, dud.id);
      assert.equal(hardest[0].correct, 0);
      assert.equal(hardest[0].served, 12);
      assert.ok(hardest[0].preview.length > 0, 'enough text to recognise the question');
    });

    test('a question too few children have seen is not ranked at all', async () => {
      // Three wrong answers is not evidence that a question is broken.
      const admin = await makeAdmin(prisma);
      const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 1 });
      for (let i = 0; i < 3; i++) {
        const student = await makeStudent(prisma);
        const attempt = await recordResult(prisma, { testId: paper.id, userId: student.id, percentage: 0 });
        await prisma.answer.create({
          data: { attemptId: attempt.id, questionId: questions[0].id, response: { optionId: 'a' }, isCorrect: false },
        });
      }
      assert.deepEqual(await agg.hardestQuestions({ kind: 'REGULAR' }, 5), []);
    });
  });
});
