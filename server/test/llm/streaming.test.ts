import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chatComplete, emitsReasoning, buildChatRequest } from '../../src/llm/providers.js';
import { startMockProvider, type MockProvider } from '../helpers/mock-provider.js';

/**
 * Reading a streamed reply, against every shape a real endpoint produces.
 *
 * This is the regression guard for the week where NVIDIA NIM connected, showed
 * green, and never produced a question. Three separate causes, all here.
 */

let mock: MockProvider;
before(async () => { mock = await startMockProvider(); });
after(async () => { await mock.close(); });

const call = (model: string, extra: Record<string, unknown> = {}) =>
  chatComplete({
    baseUrl: mock.baseUrl,
    apiKey: 'test-key',
    model,
    messages: [{ role: 'user', content: 'go' }],
    maxTokens: 500,
    ...extra,
  });

const fails = async (model: string, extra: Record<string, unknown> = {}) => {
  try {
    await call(model, extra);
    return null;
  } catch (err) {
    return err as Error & { reasoningChars?: number };
  }
};

describe('an ordinary streamed reply', () => {
  test('the pieces are joined in order', async () => {
    const res = await call('ok-stream');
    assert.equal(res.text, '{"questions":[{"n":1}]}');
  });

  test('it is marked as streamed', async () => {
    assert.equal((await call('ok-stream')).streamed, true);
  });

  test('token counts from the final chunk survive', async () => {
    const res = await call('ok-stream');
    assert.equal(res.promptTokens, 120);
    assert.equal(res.completionTokens, 9);
  });

  test('the finish reason is kept', async () => {
    assert.equal((await call('ok-stream')).finishReason, 'stop');
  });

  test('time to the first token is measured', async () => {
    assert.equal(typeof (await call('ok-stream')).firstTokenMs, 'number');
  });
});

describe('a model that thinks before answering', () => {
  test('the answer is only the answer', async () => {
    // The bug this guards: reasoning_content was never read, so the answer
    // looked empty and was reported as an empty reply from the provider.
    assert.equal((await call('thinker')).text, 'ANSWER');
  });

  test('and the working is kept separately', async () => {
    assert.equal((await call('thinker')).reasoningText, 'Let me work this out step by step. ');
  });
});

describe('a model that spends its whole budget thinking', () => {
  test('it is not reported as an empty message', async () => {
    const err = await fails('all-thinking');
    assert.doesNotMatch(err!.message, /empty message/);
  });

  test('it says the model never started the answer', async () => {
    const err = await fails('all-thinking');
    assert.match(err!.message, /never wrote an answer/);
  });

  test('and names the two settings that fix it', async () => {
    const err = await fails('all-thinking');
    assert.match(err!.message, /reply limit/i);
    assert.match(err!.message, /Thinking/);
  });

  test('and reports how much thinking there was', async () => {
    // The number the settings screen shows as "Thought first", which is what
    // tells an admin the reply limit is the problem.
    const err = await fails('all-thinking');
    assert.ok((err!.reasoningChars ?? 0) > 0, 'expected reasoningChars to be set');
  });
});

describe('replies that are cut short or oddly shaped', () => {
  test('a truncated reply still comes back, with the reason', async () => {
    const res = await call('truncated');
    assert.equal(res.text, '{"questions":[');
    assert.equal(res.finishReason, 'length');
  });

  test('an event split across two packets is reassembled', async () => {
    assert.equal((await call('split-events')).text, 'ABCD');
  });

  test('a provider that ignores the stream flag is still read', async () => {
    const res = await call('json-not-stream');
    assert.equal(res.text, 'plain body');
    assert.equal(res.streamed, false, 'and is not claimed to have been streamed');
  });

  test('an error sent part-way through is surfaced', async () => {
    const err = await fails('mid-error');
    assert.match(err!.message, /upstream capacity exceeded/);
  });
});

describe('a provider that goes quiet', () => {
  test('it gives up on silence rather than on total time', async () => {
    const started = Date.now();
    const err = await fails('stalls');
    const waited = Date.now() - started;
    // The silence alarm is 1.5s here and the absolute cap 8s. Failing at the
    // cap instead would mean the timeout is a stopwatch again.
    assert.ok(waited < 5000, `waited ${waited} ms, expected the silence alarm to fire first`);
    assert.match(err!.message, /went quiet/);
  });
});

describe('what actually goes on the wire', () => {
  test('vendor extensions are passed through', async () => {
    const echoed = JSON.parse((await call('echo', {
      tuning: {
        extraBody: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 16384 },
        temperature: 1, topP: 0.95, seed: 42, stream: false, jsonMode: 'on',
      },
    })).text);
    assert.deepEqual(echoed.chat_template_kwargs, { enable_thinking: true });
    assert.equal(echoed.reasoning_budget, 16384);
    assert.equal(echoed.temperature, 1);
    assert.equal(echoed.top_p, 0.95);
    assert.equal(echoed.seed, 42);
    assert.deepEqual(echoed.response_format, { type: 'json_object' });
    assert.equal(echoed.stream, undefined, 'streaming can be turned off');
  });

  test('the model and messages are ours, whatever the settings say', async () => {
    // A setting must never be able to redirect a request somewhere else.
    const echoed = JSON.parse((await call('echo', {
      tuning: { extraBody: { model: 'HIJACK', messages: 'HIJACK', stream: false } },
    })).text);
    assert.equal(echoed.model, 'echo');
    assert.ok(Array.isArray(echoed.messages));
  });

  test('streaming is on by default and json mode can be forced off', async () => {
    const echoed = JSON.parse((await call('echo', { tuning: { stream: true, jsonMode: 'off' } })).text);
    assert.equal(echoed.stream, true);
    assert.equal(echoed.response_format, undefined);
  });
});

describe('deciding whether a model thinks', () => {
  test('an explicit answer always wins', () => {
    assert.equal(emitsReasoning('meta/llama-3.3-70b-instruct', 'yes'), true);
    assert.equal(emitsReasoning('z-ai/glm-5.2', 'no'), false);
  });

  test('a reasoning model is recognised', () => {
    assert.equal(emitsReasoning('z-ai/glm-5.2'), true);
    assert.equal(emitsReasoning('nvidia/nemotron-3.5-lightning-30b-a3b'), true);
  });

  test('the vendor name does not decide it', () => {
    // "thinkingmachines/inkling" is not a reasoning model, and matching on the
    // whole string said it was.
    assert.equal(emitsReasoning('thinkingmachines/inkling'), false);
  });

  test('an ordinary model is still ordinary', () => {
    assert.equal(emitsReasoning('meta/llama-3.3-70b-instruct'), false);
  });
});

describe('the request preview shown on the settings screen', () => {
  test('is built by the same code that makes the call', async () => {
    const built = await buildChatRequest({
      baseUrl: mock.baseUrl,
      apiKey: 'super-secret-key',
      model: 'some/model',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      tuning: { extraBody: { reasoning_budget: 999 } },
    });
    assert.match(built.url, /\/chat\/completions$/);
    assert.equal(built.body.model, 'some/model');
    assert.equal(built.body.reasoning_budget, 999);
    // The key is in the headers here; redaction happens in the route, which is
    // the layer that decides what leaves the server.
    assert.match(String(built.headers.Authorization), /super-secret-key/);
  });
});
