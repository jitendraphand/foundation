import fs from 'node:fs/promises';

import { env } from './env.js';
import { prisma } from './db.js';
import { buildApp } from './app.js';

import { sweepExpiredAttempts } from './services/attempt.js';
import { pruneBackups } from './services/backup.js';
import { pruneSessions } from './services/sessions.js';

/**
 * The process: listen, run the scheduled work, shut down cleanly.
 *
 * The API itself is assembled in app.ts, which knows nothing about sockets or
 * timers so that a test can build it without starting either.
 */

/** How many workers there are, so the log can say which one this is. */
const workerCount = Math.max(1, Number(process.env.FOUNDATION_WORKERS ?? 1));

/** Exactly one worker runs the scheduled jobs; the cluster primary decides. */
const runsJobs = (process.env.FOUNDATION_RUNS_JOBS ?? 'true') === 'true';

const app = await buildApp();

await fs.mkdir(env.UPLOAD_DIR, { recursive: true }).catch(() => undefined);
await fs.mkdir(env.BACKUP_DIR, { recursive: true }).catch(() => undefined);

// The scheduled work, owned by one worker. Every worker running these would
// mean four sweeps a minute against the same rows and four nightly prunes -
// harmless in outcome, wasteful under load, and confusing in the logs.
const sweepTimer = runsJobs
  ? setInterval(() => {
      sweepExpiredAttempts().catch((err) => app.log.error({ err }, 'attempt sweep failed'));
    }, 60_000)
  : undefined;

// Nightly prune of old local archives. Downloaded copies are unaffected.
const pruneTimer = runsJobs
  ? setInterval(() => {
      pruneBackups().catch((err) => app.log.error({ err }, 'backup prune failed'));
      pruneSessions().catch((err) => app.log.error({ err }, 'session prune failed'));
    }, 24 * 60 * 60_000)
  : undefined;

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
  app.log.info(
    `API listening on :${env.PORT}` +
    (workerCount > 1 ? ` (worker ${process.pid}, 1 of ${workerCount}${runsJobs ? ', runs scheduled jobs' : ''})` : ''),
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
