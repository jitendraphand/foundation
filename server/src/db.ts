import { PrismaClient } from '@prisma/client';

/**
 * The connection pool, sized for this worker rather than for the process.
 *
 * DB_POOL_SIZE is a budget for the whole API - see env.ts - and the cluster
 * primary divides it, handing each worker its share in FOUNDATION_DB_POOL.
 * Without this every worker would open the full pool and four workers would
 * quietly ask Postgres for four times as many connections as the operator
 * configured, which shows up as "too many clients already" in the middle of an
 * exam rather than at startup.
 *
 * A DATABASE_URL that already names a connection_limit is left exactly as it
 * is: an operator who set it meant it.
 */
function poolUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  const share = process.env.FOUNDATION_DB_POOL;
  if (!raw || !share) return raw;

  try {
    const url = new URL(raw);
    if (url.searchParams.has('connection_limit')) return raw;
    url.searchParams.set('connection_limit', share);
    return url.toString();
  } catch {
    // Not a URL we can parse - hand it to Prisma untouched and let it complain.
    return raw;
  }
}

const url = poolUrl();

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['query', 'warn', 'error'],
  ...(url ? { datasources: { db: { url } } } : {}),
});

export async function disconnect() {
  await prisma.$disconnect();
}
