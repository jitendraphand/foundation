import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tuningFromRequestBody } from '../../src/llm/tuning.js';

/**
 * Show the request is editable. The panel shows the whole body, and a save
 * keeps the fields a vendor sample changes. The prompt itself stays with the
 * server, so rewriting messages is refused.
 */

const baseline = {
  model: 'nvidia/nemotron',
  messages: [{ role: 'system', content: '<prompt>' }],
  temperature: 0.4,
  max_tokens: 8000,
  stream: true,
  stream_options: { include_usage: true },
};

describe('saving an edited request', () => {
  test('extra fields, temperature and top_p are kept', () => {
    const edited = {
      ...baseline,
      temperature: 1,
      top_p: 0.95,
      seed: 42,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 16384,
    };
    const result = tuningFromRequestBody(edited, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tuning.temperature, 1);
    assert.equal(result.tuning.topP, 0.95);
    assert.equal(result.tuning.seed, 42);
    assert.deepEqual(result.tuning.extraBody, {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 16384,
    });
  });

  test('a changed reply size is stored as the reply limit', () => {
    const result = tuningFromRequestBody({ ...baseline, max_tokens: 20000 }, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.maxOutputTokens, 20000);
  });

  test('rewriting the prompt is refused, and says where the real prompts live', () => {
    const result = tuningFromRequestBody(
      { ...baseline, messages: [{ role: 'user', content: 'hijack' }] },
      baseline,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /messages/);
    assert.match(result.error, /Prompts/);
  });

  test('changing only the model switches the default model', () => {
    const result = tuningFromRequestBody({ ...baseline, model: 'nvidia/other' }, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.defaultModel, 'nvidia/other');
    // Everything else is kept as it was: the baseline's temperature stays.
    assert.equal(result.tuning.temperature, 0.4);
  });

  test('an empty model name is refused', () => {
    const result = tuningFromRequestBody({ ...baseline, model: '   ' }, baseline);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /model/i);
  });

  test('a temperature change alone is kept, with nothing else flagged', () => {
    const result = tuningFromRequestBody({ ...baseline, temperature: 1 }, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tuning.temperature, 1);
    assert.equal(result.defaultModel, undefined);
  });

  test('renaming the reply-size field sticks when the endpoint wants the other name', () => {
    const { max_tokens: _dropped, ...rest } = baseline;
    const edited = { ...rest, max_completion_tokens: 100000 };
    const result = tuningFromRequestBody(edited, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tuning.tokenKey, 'max_completion_tokens');
    assert.equal(result.maxOutputTokens, 100000);
  });

  test('leaving the default field alone stores no choice', () => {
    const result = tuningFromRequestBody({ ...baseline, temperature: 0.9 }, baseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tuning.tokenKey, undefined);
  });

  test('a reasoning model keeps its field without storing a choice', () => {
    const { max_tokens: _dropped, ...rest } = baseline;
    const reasoningBaseline = { ...rest, model: 'o3-mini', max_completion_tokens: 8000 };
    const result = tuningFromRequestBody({ ...reasoningBaseline, temperature: 0.7 }, reasoningBaseline);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tuning.tokenKey, undefined);
  });

  test('stream_options is derived from the stream flag, so editing it is harmless', () => {
    const edited = { ...baseline, stream_options: { include_usage: false } };
    const result = tuningFromRequestBody(edited, baseline);
    assert.equal(result.ok, true);
  });

  test('an extra field that is taken out does not linger', () => {
    const result = tuningFromRequestBody(baseline, baseline, {
      extraBody: { reasoning_budget: 16384 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.tuning.extraBody, {});
  });
});
