import { execFileSync } from 'node:child_process';

/**
 * Rebuild the database, then start the API - in that order, in one process.
 *
 * The order is the whole point. Playwright starts its `webServer` entries
 * *before* `globalSetup`, so preparing the database there rebuilt it underneath
 * an API that had already connected: the first sign-in came back 500 from a
 * pool pointing at a database that no longer existed. Doing both here makes the
 * ordering structural rather than something to remember.
 *
 * Everything is dropped and recreated on every run on purpose. These tests
 * describe a school's first morning, and a suite that only passes against a
 * database somebody prepared by hand will pass for ever and mean nothing.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const url = new URL(DATABASE_URL);
const database = url.pathname.slice(1);
const maintenance = new URL(DATABASE_URL);
maintenance.pathname = '/postgres';

const psql = (sql) =>
  execFileSync('psql', [maintenance.toString(), '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });

// Anything still connected would refuse the DROP.
psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${database}' AND pid <> pg_backend_pid()`);
psql(`DROP DATABASE IF EXISTS "${database}"`);
psql(`CREATE DATABASE "${database}"`);

// Migrations rather than db push: this is the schema an upgrade produces, and
// the browser tests should meet the same one a school does.
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'pipe' });

// The seed makes the administrator, the grades and the divisions - exactly what
// deploy/local.sh does on a new machine.
execFileSync('node', ['dist/seed.js'], { stdio: 'pipe' });

console.log(`[e2e] ${database} rebuilt and seeded`);

// Only now does anything connect for real. The path is relative to this file,
// not to the working directory the prisma commands above needed.
await import('../../server/dist/index.js');
