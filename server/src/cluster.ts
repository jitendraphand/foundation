import cluster from 'node:cluster';
import os from 'node:os';
import { env } from './env.js';

/**
 * The container entry point: one API worker per core.
 *
 * Node executes JavaScript on a single thread. Before this, the whole API was
 * one process, so a school running the system on a large machine used exactly
 * one core of it. Measured with 200 students refreshing the dashboard: the
 * process pegged one core, Postgres sat idle, three cores did nothing, and
 * every reply took about a second. Nothing was overloaded except the one thread
 * everybody was queued behind.
 *
 * Workers accept on the same socket and the kernel spreads connections across
 * them, so this needs no load balancer and no change to Caddy.
 *
 * Three things have to be true for that to be safe, and all three are arranged
 * here rather than left to chance:
 *
 *  1. **The scheduled jobs must not run N times.** The expiry sweep and the
 *     nightly prune belong to one worker, chosen here and told so.
 *  2. **The rate limits must stay global.** They are counted in memory, so
 *     N workers would silently allow N times as many requests. Each worker is
 *     given its share of the ceiling instead.
 *  3. **The connection pool must stay within the database's limit.**
 *     DB_POOL_SIZE is a total, and each worker gets an equal slice.
 *
 * A worker that dies is replaced. A worker that dies immediately, repeatedly,
 * is a bug rather than a blip, so the primary gives up instead of spinning.
 */

const cpus = os.availableParallelism?.() ?? os.cpus().length;
const workers = env.WEB_CONCURRENCY > 0 ? env.WEB_CONCURRENCY : Math.min(cpus, 8);

// One worker is the ordinary case in development and on a single-core box.
// Skip the fork entirely so the process tree, the logs and the debugger all
// look exactly as they did before.
if (workers <= 1 || !cluster.isPrimary) {
  process.env.FOUNDATION_RUNS_JOBS ??= 'true';
  process.env.FOUNDATION_WORKERS ??= '1';
  await import('./index.js');
} else {
  const share = Math.max(2, Math.floor(env.DB_POOL_SIZE / workers));
  console.log(
    `[cluster] ${workers} API workers on ${cpus} cores, ` +
    `${share} database connections each (${share * workers} of ${env.DB_POOL_SIZE} budgeted)`,
  );

  let stopping = false;
  let quickDeaths = 0;
  /** Which worker currently owns the scheduled jobs. Exactly one, always. */
  let jobOwner = -1;
  const startedAt = new Map<number, number>();

  const spawn = (jobs: boolean) => {
    const worker = cluster.fork({
      FOUNDATION_RUNS_JOBS: jobs ? 'true' : 'false',
      FOUNDATION_WORKERS: String(workers),
      FOUNDATION_DB_POOL: String(share),
    });
    startedAt.set(worker.id, Date.now());
    if (jobs) jobOwner = worker.id;
    return worker;
  };

  spawn(true);
  for (let i = 1; i < workers; i++) spawn(false);

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;

    const lived = Date.now() - (startedAt.get(worker.id) ?? Date.now());
    startedAt.delete(worker.id);
    // The replacement inherits the timers if, and only if, the worker that died
    // was holding them - so they never stop and never double up.
    const inheritsJobs = worker.id === jobOwner;

    // A worker that never got as far as listening is not a blip. Restarting it
    // for ever would hide a configuration error behind a busy log.
    if (lived < 5_000) {
      quickDeaths++;
      if (quickDeaths >= workers * 3) {
        console.error('[cluster] workers keep dying at startup - stopping so the problem is visible');
        process.exit(1);
      }
    } else {
      quickDeaths = 0;
    }

    console.error(
      `[cluster] worker ${worker.process.pid} exited (${signal ?? code}) after ${Math.round(lived / 1000)}s, restarting`,
    );
    spawn(inheritsJobs);
  });

  const shutdown = (signal: string) => {
    stopping = true;
    console.log(`[cluster] ${signal} received, stopping ${Object.keys(cluster.workers ?? {}).length} workers`);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal as NodeJS.Signals);
    // Workers close their servers gracefully; this is the backstop.
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
