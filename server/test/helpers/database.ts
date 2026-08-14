import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * A real Postgres, or an honest skip.
 *
 * These tests exercise things that only exist in the database - a conditional
 * UPDATE claiming a row, aggregate SQL over jsonb, an index being used - so
 * mocking the database would mean testing the mock. That means they need one,
 * and a contributor without one should get a clear skip rather than a wall of
 * connection errors.
 *
 * Point TEST_DATABASE_URL at a database you do not mind losing. It is dropped
 * and recreated at the start of every run.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const hasDatabase = TEST_DATABASE_URL.length > 0;

export const skipWithoutDatabase = hasDatabase
  ? false
  : 'set TEST_DATABASE_URL to run the tests that need a database';

let client: PrismaClient | null = null;

/**
 * Migrates the test database and hands back a client.
 *
 * Migrations rather than `db push`, so the tests run against the same schema a
 * deployment gets - including the indexes, which is the point of some of them.
 */
export async function testDatabase(): Promise<PrismaClient> {
  if (client) return client;
  if (!hasDatabase) throw new Error('no TEST_DATABASE_URL');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });

  client = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } }, log: ['warn', 'error'] });
  await client.$connect();
  return client;
}

export async function closeDatabase(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

/**
 * Empties every table between test files.
 *
 * TRUNCATE ... CASCADE rather than deleting in dependency order: the order is a
 * detail of the schema, and a test suite that has to be updated whenever a
 * foreign key is added is a test suite people stop running.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
