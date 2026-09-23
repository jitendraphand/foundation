import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planBatches, questionsPerCall, tokenBudget } from '../../src/llm/generate.js';

/**
 * A reply limit is the size of one call. 200000 tokens at 1500 per question
 * holds a hundred questions, so that request is one call. Ten was a fallback
 * for when nobody had set a limit, and it was also being applied on top of a
 * limit that had room.
 */

describe('how many questions fit in one call', () => {
  test('200000 tokens at 1500 each is one call for 100 questions', () => {
    const per = questionsPerCall(1500, 200_000);
    assert.ok(per >= 100, `expected at least 100 per call, got ${per}`);
    assert.deepEqual(planBatches(100, per), [100]);
    // The completion asked for is the questions themselves, under the limit.
    assert.equal(tokenBudget(1500, 100, 200_000), 150_000);
  });

  test('a low ceiling still splits the run', () => {
    // 4096 * 0.9 / 1500 = 2.
    assert.equal(questionsPerCall(1500, 4096), 2);
    assert.deepEqual(planBatches(10, 2), [2, 2, 2, 2, 2]);
    assert.equal(tokenBudget(1500, 2, 4096), 3000);
  });

  test('no known ceiling stays at ten, inside the 32k stand-in', () => {
    assert.equal(questionsPerCall(1500), 10);
    assert.equal(tokenBudget(1500, 10), 15_000);
    assert.equal(tokenBudget(1500, 100), 32_000);
  });
});
