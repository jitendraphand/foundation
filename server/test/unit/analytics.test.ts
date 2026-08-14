import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBreakdown, findWeakAreas, weakAreasToPromptHint, type Breakdown, type GradedRow } from '../../src/lib/analytics.js';

/**
 * The per-axis breakdown, and what counts as a weakness.
 *
 * This is the input to every report and to the practice-test prompt, so a
 * mistake here is invisible until a teacher acts on it.
 */

const row = (over: Partial<GradedRow> = {}): GradedRow => ({
  questionId: 'q1',
  isCorrect: true,
  marksAwarded: 1,
  maxMarks: 1,
  answered: true,
  timeSpentMs: 30_000,
  difficultyTag: 'medium',
  cognitiveTag: 'application',
  skillTags: ['fraction_operations'],
  subject: 'Mathematics',
  topic: null,
  subtopic: null,
  ...over,
});

describe('building a breakdown', () => {
  test('a question counts once on each axis it is tagged with', () => {
    const b = buildBreakdown([row()]);
    assert.equal(b.byDifficulty.medium.total, 1);
    assert.equal(b.byCognitive.application.total, 1);
    assert.equal(b.bySkill.fraction_operations.total, 1);
  });

  test('a question with two skills counts once under each', () => {
    const b = buildBreakdown([row({ skillTags: ['estimation', 'mensuration'] })]);
    assert.equal(b.bySkill.estimation.total, 1);
    assert.equal(b.bySkill.mensuration.total, 1);
  });

  test('accuracy is correct over total, not over answered', () => {
    // A question left blank still counts against the child's accuracy on that
    // skill: not attempting it is not the same as not being examined on it.
    const b = buildBreakdown([
      row({ isCorrect: true }),
      row({ isCorrect: false, answered: false, marksAwarded: 0 }),
    ]);
    assert.equal(b.bySkill.fraction_operations.total, 2);
    assert.equal(b.bySkill.fraction_operations.answered, 1);
    assert.equal(b.bySkill.fraction_operations.accuracy, 0.5);
  });

  test('an untagged topic does not become an empty bucket', () => {
    const b = buildBreakdown([row({ topic: null, subtopic: null })]);
    assert.deepEqual(Object.keys(b.byTopic), []);
    assert.deepEqual(Object.keys(b.bySubtopic), []);
  });

  test('average time is per question, not per axis entry', () => {
    const b = buildBreakdown([
      row({ timeSpentMs: 20_000 }),
      row({ timeSpentMs: 40_000 }),
    ]);
    assert.equal(b.bySkill.fraction_operations.avgTimeMs, 30_000);
  });

  test('no rows produces empty axes rather than throwing', () => {
    const b = buildBreakdown([]);
    assert.deepEqual(b, { byDifficulty: {}, byCognitive: {}, bySkill: {}, byTopic: {}, bySubtopic: {} });
  });
});

/** A breakdown carrying one skill at a known score. */
function skillAt(key: string, correct: number, total: number): Breakdown {
  return {
    byDifficulty: {}, byCognitive: {}, byTopic: {}, bySubtopic: {},
    bySkill: {
      [key]: { correct, total, answered: total, marks: correct, maxMarks: total, accuracy: correct / total, avgTimeMs: 0 },
    },
  };
}

describe('deciding what counts as a weakness', () => {
  test('a skill below the threshold with enough questions is reported', () => {
    const weak = findWeakAreas([skillAt('fractions', 2, 10)]);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].key, 'fractions');
    assert.equal(weak[0].accuracy, 0.2);
  });

  test('too few questions is not a weakness, however bad it looks', () => {
    // 0 out of 2 is not evidence of anything, and telling a child it is would
    // be worse than saying nothing.
    assert.deepEqual(findWeakAreas([skillAt('fractions', 0, 2)], { minSample: 3 }), []);
  });

  test('a skill above the threshold is not reported', () => {
    assert.deepEqual(findWeakAreas([skillAt('fractions', 8, 10)], { accuracyThreshold: 0.7 }), []);
  });

  test('the threshold is exclusive: exactly on the line is not weak', () => {
    assert.deepEqual(findWeakAreas([skillAt('fractions', 7, 10)], { accuracyThreshold: 0.7 }), []);
    assert.equal(findWeakAreas([skillAt('fractions', 69, 100)], { accuracyThreshold: 0.7 }).length, 1);
  });

  test('the same skill across several papers is summed, not averaged', () => {
    const weak = findWeakAreas([skillAt('fractions', 1, 5), skillAt('fractions', 2, 5)]);
    assert.equal(weak[0].correct, 3);
    assert.equal(weak[0].total, 10);
  });

  test('a bigger sample outranks a worse-looking small one', () => {
    // 4/10 is a firmer finding than 1/3, so it should be acted on first even
    // though its accuracy is higher.
    const weak = findWeakAreas([skillAt('solid', 4, 10), skillAt('flimsy', 1, 3)]);
    assert.equal(weak[0].key, 'solid');
    assert.ok(weak[0].priority > weak[1].priority);
  });

  test('only the axes asked for are returned', () => {
    const b: Breakdown = {
      ...skillAt('fractions', 1, 10),
      byTopic: { Circles: { correct: 1, total: 10, answered: 10, marks: 1, maxMarks: 10, accuracy: 0.1, avgTimeMs: 0 } },
    };
    const studentView = findWeakAreas([b], { axes: ['difficulty', 'cognitive', 'skill'] });
    assert.ok(studentView.every((w) => w.axis !== 'topic'));
    const teacherView = findWeakAreas([b]);
    assert.ok(teacherView.some((w) => w.axis === 'topic'));
  });

  test('the limit is applied after filtering, so it returns that many', () => {
    const many = Array.from({ length: 20 }, (_, i) => skillAt(`skill${i}`, 1, 10));
    assert.equal(findWeakAreas(many, { limit: 6 }).length, 6);
  });
});

describe('the sentence handed to the practice-test prompt', () => {
  test('names each weakness with its score', () => {
    const hint = weakAreasToPromptHint(findWeakAreas([skillAt('fraction_operations', 2, 10)]));
    assert.match(hint, /fraction_operations/);
    assert.match(hint, /2\/10/);
    assert.match(hint, /20%/);
  });

  test('and says so plainly when there is nothing to target', () => {
    const hint = weakAreasToPromptHint([]);
    assert.match(hint, /No specific weak areas/);
    // Never an empty string: it is interpolated straight into a prompt, and a
    // blank there reads as a missing instruction.
    assert.ok(hint.length > 20);
  });
});
