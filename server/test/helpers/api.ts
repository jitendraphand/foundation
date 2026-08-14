import type { FastifyInstance } from 'fastify';
import type { PrismaClient, User } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { signSession } from '../../src/middleware/auth.js';
import { createSession } from '../../src/services/sessions.js';

/**
 * The API in-process, driven with fastify's inject().
 *
 * No socket, no port, no server to tear down between files - inject runs a
 * request through the whole stack, hooks and all, and hands back the reply. So
 * these tests cover what a route actually enforces rather than what the handler
 * would do if it were called directly.
 */

export interface TestApi {
  app: FastifyInstance;
  /** A signed-in caller, as the browser would present itself. */
  as: (user: Pick<User, 'id' | 'username' | 'role'>) => Promise<Caller>;
  close: () => Promise<void>;
}

export interface Caller {
  get: (url: string) => Promise<Reply>;
  post: (url: string, body?: unknown) => Promise<Reply>;
  patch: (url: string, body?: unknown) => Promise<Reply>;
  del: (url: string) => Promise<Reply>;
}

export interface Reply {
  status: number;
  body: any;
  raw: string;
}

export async function testApi(_prisma: PrismaClient): Promise<TestApi> {
  const app = await buildApp({ silent: true });
  await app.ready();

  const request = (cookie: string) => {
    const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<Reply> => {
      // Only declare a JSON body when there is one: fastify rejects a request
      // that announces application/json and then sends nothing, which several
      // of these routes legitimately do (start, submit).
      const res = await app.inject({
        method,
        url,
        headers: payload === undefined ? { cookie } : { cookie, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      let body: unknown = null;
      try { body = JSON.parse(res.body); } catch { /* not JSON, keep raw */ }
      return { status: res.statusCode, body, raw: res.body };
    };
    return {
      get: (url: string) => call('GET', url),
      post: (url: string, body?: unknown) => call('POST', url, body),
      patch: (url: string, body?: unknown) => call('PATCH', url, body),
      del: (url: string) => call('DELETE', url),
    };
  };

  return {
    app,
    as: async (user) => {
      // A real session row, so the auth middleware's revocation and idle checks
      // run exactly as they do in production.
      const session = await createSession(user.id, { ip: '127.0.0.1', userAgent: 'test' });
      const token = signSession({ sub: user.id, username: user.username, role: user.role, sid: session.id });
      return request(`foundation_session=${token}`);
    },
    close: async () => { await app.close(); },
  };
}

/** A caller who has not signed in. */
export function anonymous(app: FastifyInstance) {
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({
      method, url,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    let body: unknown = null;
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body, raw: res.body };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body),
  };
}
