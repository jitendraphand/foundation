import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { createRequire } from 'node:module';

import { env, isProd } from './env.js';
import { prisma } from './db.js';
import { requireAdmin, requirePermission } from './middleware/auth.js';
import type { Permission } from './lib/permissions.js';

import authRoutes from './routes/auth.js';
import studentRoutes from './routes/student.js';
import activityRoutes from './routes/activity.js';
import adminUserRoutes from './routes/admin/users.js';
import adminQuestionRoutes from './routes/admin/questions.js';
import adminTestRoutes from './routes/admin/tests.js';
import adminAnalyticsRoutes from './routes/admin/analytics.js';
import adminSettingsRoutes from './routes/admin/settings.js';
import adminBackupRoutes from './routes/admin/backup.js';
import adminAssetRoutes, { assetReadRoutes } from './routes/admin/assets.js';
import adminActivityRoutes from './routes/admin/activities.js';

/**
 * The API, assembled but not listening.
 *
 * Separate from index.ts so it can be built inside a test. An entry point that
 * opens a socket the moment it is imported cannot be exercised by anything
 * except a subprocess, which is how route-level behaviour - who may call what,
 * and what a reply is allowed to contain - ends up untested.
 *
 * Everything about the *process* stays in index.ts: listening, the scheduled
 * jobs, and shutting down.
 */

/**
 * Pretty logs are a development nicety, not a requirement. Production ships
 * without pino-pretty, so resolve it before asking pino to load it - otherwise
 * a NODE_ENV=development run against the production image dies at startup.
 */
const prettyTransport = (() => {
  if (isProd) return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
})();

export interface BuildOptions {
  /** Quiet logs, for tests. */
  silent?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.silent
      ? false
      : {
          level: isProd ? 'info' : 'debug',
          transport: prettyTransport,
        },
    // Caddy is the only thing in front of us, so its X-Forwarded-For is
    // trustworthy and gives real client IPs for rate limiting.
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cookie, { secret: env.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

  /**
   * Rate limits under clustering.
   *
   * These are counted in this process's memory, so with N workers each one
   * enforces the configured number independently. They are deliberately left
   * that way rather than divided by the worker count.
   *
   * The reason is that a browser keeps its connection open, so one client's
   * requests overwhelmingly land on one worker. Dividing would therefore punish
   * the case these limits exist for - a single runaway tab, still correctly
   * stopped at its ceiling - while barely inconveniencing someone opening
   * connections deliberately, who spreads across workers either way.
   *
   * That is an acceptable trade because none of these is a security boundary,
   * and the things that are boundaries do not live in memory: brute force is
   * stopped by the per-account lockout in the database, sessions are revoked in
   * the database, and every privilege is checked against it. See the note on
   * EXAM_LIMIT in routes/student.ts.
   */
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  // In production Caddy serves the app and the API from the same origin, so
  // CORS is not needed. In development Vite runs on :5173.
  if (!isProd) {
    await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues[0]?.message ?? 'Some details were not valid.',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: 'Too many requests. Please wait a moment and try again.' });
    }

    request.log.error({ err: error }, 'request failed');

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'Something went wrong on the server. Please try again.' : error.message,
    });
  });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, version: '1.0.0', time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(studentRoutes);
  // Registered outside the student gate: these are the routes used to clear it.
  await app.register(activityRoutes);
  await app.register(assetReadRoutes);

  /**
   * Every admin area is gated in one place, so a new route cannot be added
   * without a privilege check.
   *
   * Each module is registered in its own scope carrying the privilege that area
   * needs. Where a module spans two privileges the scope requires either, and
   * the individual sensitive routes re-check the specific one - see
   * questions.ts (generate vs review) and tests.ts (manage vs release).
   */
  type AdminRoutes = (instance: FastifyInstance) => Promise<void>;

  const adminArea = (required: Permission | Permission[], routes: AdminRoutes) =>
    app.register(async (scope) => {
      scope.addHook('preHandler', requireAdmin);
      scope.addHook('preHandler', requirePermission(required));
      await routes(scope as FastifyInstance);
    });

  // Student management and administrator management live in the same module;
  // each route inside re-checks the specific privilege it needs.
  await adminArea(['users.manage', 'admins.manage'], adminUserRoutes);
  await adminArea(['questions.generate', 'questions.review'], adminQuestionRoutes);
  await adminArea(['tests.manage', 'results.release'], adminTestRoutes);
  await adminArea('analytics.view', adminAnalyticsRoutes);
  await adminArea('settings.manage', adminSettingsRoutes);
  await adminArea('backups.manage', adminBackupRoutes);
  // Images are attached to questions and to activity cards alike.
  await adminArea(['questions.review', 'activities.manage'], adminAssetRoutes);
  await adminArea('activities.manage', adminActivityRoutes);

  return app;
}
