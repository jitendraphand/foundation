import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gradeAnswer, marksFor, round2, validateResponse } from '../../src/lib/grading.js';

/**
 * Marking is the one thing in this system nobody can check by eye.
 *
 * A wrong score on a page is a complaint; a wrong score in the database is a
 * report card. These are the cases that decide a child's mark, written out so
 * that changing the rules has to be deliberate.
 */

describe('a single-answer question', () => {
  const key = { correctOptionId: 'b' };

  test('the right option earns the marks', () => {
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, { optionId: 'b' }), { isCorrect: true, fraction: 1 });
  });

  test('a wrong option earns none', () => {
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, { optionId: 'a' }), { isCorrect: false, fraction: 0 });
  });

  test('no answer at all is not an error, just no marks', () => {
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, null), { isCorrect: false, fraction: 0 });
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, undefined), { isCorrect: false, fraction: 0 });
  });

  test('a malformed response scores zero rather than throwing', () => {
    // A student cannot cause a 500 by sending nonsense, and a whole paper
    // cannot fail to grade because one row is odd.
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, { optionIds: ['b'] }), { isCorrect: false, fraction: 0 });
    assert.deepEqual(gradeAnswer('MCQ_SINGLE', key, 'b'), { isCorrect: false, fraction: 0 });
  });

  test('option ids are matched exactly, not loosely', () => {
    assert.equal(gradeAnswer('MCQ_SINGLE', key, { optionId: 'B' }).isCorrect, false);
    assert.equal(gradeAnswer('MCQ_SINGLE', key, { optionId: ' b' }).isCorrect, false);
  });
});

describe('a multiple-answer question without partial credit', () => {
  const key = { correctOptionIds: ['a', 'c'], partialCredit: false };

  test('all of them and nothing else is correct', () => {
    assert.deepEqual(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'c'] }), { isCorrect: true, fraction: 1 });
  });

  test('order does not matter', () => {
    assert.equal(gradeAnswer('MCQ_MULTI', key, { optionIds: ['c', 'a'] }).isCorrect, true);
  });

  test('a repeated tick does not count twice', () => {
    assert.equal(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'a', 'c'] }).isCorrect, true);
  });

  test('missing one of them earns nothing', () => {
    assert.deepEqual(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a'] }), { isCorrect: false, fraction: 0 });
  });

  test('an extra wrong tick earns nothing', () => {
    assert.deepEqual(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'b', 'c'] }), { isCorrect: false, fraction: 0 });
  });

  test('ticking nothing earns nothing', () => {
    assert.deepEqual(gradeAnswer('MCQ_MULTI', key, { optionIds: [] }), { isCorrect: false, fraction: 0 });
  });
});

describe('a multiple-answer question with partial credit', () => {
  const key = { correctOptionIds: ['a', 'b', 'c'], partialCredit: true };

  test('all three is still full marks and still counts as correct', () => {
    assert.deepEqual(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'b', 'c'] }), { isCorrect: true, fraction: 1 });
  });

  test('two of three earns two thirds, but is not "correct"', () => {
    const grade = gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'b'] });
    assert.equal(grade.isCorrect, false);
    assert.ok(Math.abs(grade.fraction - 2 / 3) < 1e-9);
  });

  test('a wrong tick cancels out a right one', () => {
    // Two right, one wrong: (2 - 1) / 3.
    const grade = gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'b', 'z'] });
    assert.ok(Math.abs(grade.fraction - 1 / 3) < 1e-9);
  });

  test('and enough wrong ticks floor at zero rather than going negative', () => {
    // Partial credit must never turn into a penalty by the back door; that is
    // what negative marking is for, and it is applied separately.
    assert.equal(gradeAnswer('MCQ_MULTI', key, { optionIds: ['x', 'y', 'z'] }).fraction, 0);
    assert.equal(gradeAnswer('MCQ_MULTI', key, { optionIds: ['a', 'x', 'y', 'z'] }).fraction, 0);
  });
});

describe('turning a grade into marks', () => {
  const right = { isCorrect: true, fraction: 1 };
  const wrong = { isCorrect: false, fraction: 0 };
  const half = { isCorrect: false, fraction: 0.5 };

  test('a correct answer earns the question\'s marks', () => {
    assert.equal(marksFor(right, 4, 1, true), 4);
  });

  test('a wrong answer loses the negative marks', () => {
    assert.equal(marksFor(wrong, 4, 1, true), -1);
  });

  test('a blank never loses marks, even with negative marking on', () => {
    // Guessing is penalised; leaving it blank is not. A student who runs out of
    // time must not be worse off than one who never opened the paper.
    assert.equal(marksFor(wrong, 4, 1, false), 0);
    assert.equal(marksFor(right, 4, 1, false), 0);
  });

  test('partial credit is never penalised', () => {
    assert.equal(marksFor(half, 4, 1, true), 2);
  });

  test('a negative-marks setting given as a positive number still subtracts', () => {
    assert.equal(marksFor(wrong, 4, 0.25, true), -0.25);
    assert.equal(marksFor(wrong, 4, -0.25, true), -0.25);
  });

  test('with negative marking off, a wrong answer is simply zero', () => {
    assert.equal(marksFor(wrong, 4, 0, true), 0);
  });
});

describe('rounding', () => {
  test('halves round up rather than to even', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(2.675), 2.68);
  });

  test('and a third of a mark does not accumulate error over a paper', () => {
    let total = 0;
    for (let i = 0; i < 30; i++) total = round2(total + round2(1 / 3));
    assert.equal(total, 9.9);
  });
});

describe('what a student is allowed to send', () => {
  test('a well-formed single answer is accepted', () => {
    assert.deepEqual(validateResponse('MCQ_SINGLE', { optionId: 'a' }), { optionId: 'a' });
  });

  test('an empty option id is refused', () => {
    assert.throws(() => validateResponse('MCQ_SINGLE', { optionId: '' }));
  });

  test('the wrong shape for the format is refused', () => {
    assert.throws(() => validateResponse('MCQ_SINGLE', { optionIds: ['a'] }));
  });
});
