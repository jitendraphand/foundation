import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for an OpenAI-shaped endpoint, with every awkward behaviour a real
 * one produces.
 *
 * Written after a week of NVIDIA NIM runs that connected and then hung. None of
 * these is hypothetical: each is something an endpoint actually did, and each
 * needed a different response from the reader.
 *
 * The model name chooses the behaviour:
 *
 *   ok-stream        content in several chunks, usage in the last
 *   thinker          reasoning_content in its own field, then content
 *   all-thinking     reasoning_content only, never any content
 *   truncated        a little content then finish_reason=length
 *   stalls           two chunks then silence for ever
 *   split-events     one TCP packet carrying half an SSE event
 *   json-not-stream  answers a streaming request with an ordinary JSON body
 *   mid-error        starts fine, then sends an error event
 *   echo             replies with the request body, so a test can inspect it
 *
 * Listens on an ephemeral port so tests can run in parallel and on a machine
 * where something else already holds 4970.
 */
export interface MockProvider {
  /** Base URL to hand to chatComplete, including /v1. */
  baseUrl: string;
  close: () => Promise<void>;
}

const send = (res: http.ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (d: unknown, extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMockProvider(): Promise<MockProvider> {
  const open = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* leave it empty */ }
      const model = String(body.model ?? '');
      open.add(res);
      res.on('close', () => open.delete(res));

      if (model === 'echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      }

      if (model === 'json-not-stream') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { content: 'plain body' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        }));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (model === 'ok-stream') {
        send(res, delta({ role: 'assistant' }));
        for (const piece of ['{"questions"', ':[{"n":1}', ']}']) {
          await pause(10);
          send(res, delta({ content: piece }));
        }
        send(res, { ...delta({}, { finish_reason: 'stop' }), usage: { prompt_tokens: 120, completion_tokens: 9 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (model === 'thinker') {
        for (const think of ['Let me work ', 'this out step by step. ']) {
          await pause(8);
          send(res, delta({ reasoning_content: think }));
        }
        await pause(8);
        send(res, delta({ content: 'ANSWER' }));
        send(res, delta({}, { finish_reason: 'stop' }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (model === 'all-thinking') {
        for (let i = 0; i < 4; i++) {
          await pause(5);
          send(res, delta({ reasoning_content: 'thinking and thinking and thinking ' }));
        }
        send(res, delta({}, { finish_reason: 'length' }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (model === 'truncated') {
        send(res, delta({ content: '{"questions":[' }));
        await pause(5);
        send(res, delta({}, { finish_reason: 'length' }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (model === 'mid-error') {
        send(res, delta({ content: 'starting' }));
        await pause(5);
        send(res, { error: { message: 'upstream capacity exceeded' } });
        return res.end();
      }

      if (model === 'split-events') {
        // One write carrying one and a half events, then the other half.
        const first = `data: ${JSON.stringify(delta({ content: 'AB' }))}\n\n`;
        const second = `data: ${JSON.stringify(delta({ content: 'CD' }))}\n\n`;
        const half = Math.floor(second.length / 2);
        res.write(first + second.slice(0, half));
        await pause(10);
        res.write(second.slice(half));
        send(res, delta({}, { finish_reason: 'stop' }));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (model === 'stalls') {
        send(res, delta({ content: 'one' }));
        await pause(20);
        send(res, delta({ content: 'two' }));
        return; // ...and then nothing, for ever.
      }

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        // The stalling case leaves a response open on purpose; end them so the
        // test process is not held alive by its own fixture.
        for (const res of open) res.end();
        server.close(() => resolve());
      }),
  };
}
