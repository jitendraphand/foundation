import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import fs from 'node:fs/promises';

import { env, isProd } from './env.js';
import { prisma } from './db.js';
import { requireAdmin } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import studentRoutes from './routes/student.js';
import adminUserRoutes from './routes/admin/users.js';
import adminQuestionRoutes from './routes/admin/questions.js';
import adminTestRoutes from './routes/admin/tests.js';
import adminAnalyticsRoutes from './routes/admin/analytics.js';
import adminSettingsRoutes from './routes/admin/settings.js';
import adminBackupRoutes from './routes/admin/backup.js';
import adminAssetRoutes, { assetReadRoutes } from './routes/admin/assets.js';

import { sweepExpiredAttempts } from './services/attempt.js';
import { pruneBackups } from './services/backup.js';

const app = Fastify({
  logger: {
    level: isProd ? 'info' : 'debug',
    transport: isProd ? undefined : { target: 'pino-pretty' },
  },
  // Caddy is the only thing in front of us, so its X-Forwarded-For is
  // trustworthy and gives real client IPs for rate limiting.
  trustProxy: true,
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cookie, { secret: env.JWT_SECRET });
await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

await app.register(rateLimit, {
  global: false,
  max: 300,
  timeWindow: '1 minute',
});

// In production Caddy serves the app and the API from the same origin, so CORS
// is not needed. In development Vite runs on :5173.
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
await app.register(assetReadRoutes);

// Every admin route is gated in one place, so a new admin route cannot be
// added without the check.
await app.register(async (scope) => {
  scope.addHook('preHandler', requireAdmin);
  await scope.register(adminUserRoutes);
  await scope.register(adminQuestionRoutes);
  await scope.register(adminTestRoutes);
  await scope.register(adminAnalyticsRoutes);
  await scope.register(adminSettingsRoutes);
  await scope.register(adminBackupRoutes);
  await scope.register(adminAssetRoutes);
});

await fs.mkdir(env.UPLOAD_DIR, { recursive: true }).catch(() => undefined);
await fs.mkdir(env.BACKUP_DIR, { recursive: true }).catch(() => undefined);

// Close attempts whose timer expired while the student's browser was shut.
const sweepTimer = setInterval(() => {
  sweepExpiredAttempts().catch((err) => app.log.error({ err }, 'attempt sweep failed'));
}, 60_000);

// Nightly prune of old local archives. Downloaded copies are unaffected.
const pruneTimer = setInterval(() => {
  pruneBackups().catch((err) => app.log.error({ err }, 'backup prune failed'));
}, 24 * 60 * 60_000);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  clearInterval(sweepTimer);
  clearInterval(pruneTimer);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`API listening on :${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
