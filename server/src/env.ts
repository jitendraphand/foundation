import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('foundation_123'),
  SESSION_TTL_MINUTES: z.coerce.number().default(720),

  /**
   * Minutes of no requests at all before a session ends. 0 disables it.
   *
   * Separate from SESSION_TTL_MINUTES, which is the absolute lifetime. A
   * student writing a paper heartbeats every 20 seconds, so an exam in
   * progress can never go idle; this catches the shared library computer
   * somebody walked away from.
   */
  IDLE_TIMEOUT_MINUTES: z.coerce.number().min(0).default(30),

  /**
   * One account, one device. Signing in ends any other live session for that
   * account, so credentials cannot be shared around a classroom.
   */
  SINGLE_DEVICE_LOGIN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BACKUP_RETENTION_DAYS: z.coerce.number().default(7),
  /**
   * How long to wait with *nothing arriving* before giving up on a provider.
   *
   * With streaming this is a silence alarm rather than a deadline: a long
   * answer may legitimately take many minutes, but a gap this long means the
   * provider has stopped sending. Non-streaming calls still treat it as the
   * whole-request timeout, because there is nothing else to measure.
   */
  LLM_TIMEOUT_MS: z.coerce.number().default(180_000),
  /**
   * The backstop for a streamed reply that keeps trickling for ever. Generous
   * on purpose: it exists so a run cannot hang indefinitely, not to bound how
   * long a big batch may take.
   */
  LLM_MAX_MS: z.coerce.number().default(900_000),
  PUBLIC_HOST: z.string().default('localhost'),
  UPLOAD_DIR: z.string().default('/app/uploads'),
  BACKUP_DIR: z.string().default('/app/backups'),

  /**
   * How many API worker processes to run.
   *
   * Node runs JavaScript on one thread, so one process uses one core however
   * large the machine is. Measured with 200 students on the dashboard at once:
   * the process sat at 100% of a single core while the database was idle and
   * the other cores did nothing, and every reply took about a second. The
   * hardware was not the limit; the fact that only one core was being asked
   * was.
   *
   * 0 means "one per core, capped at 8" - more workers than that buys little
   * for this workload and costs a database connection each. 1 disables
   * clustering entirely, which is what development does.
   */
  WEB_CONCURRENCY: z.coerce.number().int().min(0).max(64).default(0),

  /**
   * Database connections across *all* workers, not per worker.
   *
   * Stated as a total because that is the number Postgres cares about:
   * max_connections is a property of the server, and getting this wrong is how
   * a deployment starts refusing connections under exam load. Each worker is
   * given an equal share, and at least two.
   */
  DB_POOL_SIZE: z.coerce.number().int().min(2).max(500).default(20),

  /**
   * Marks the session cookie Secure, so the browser only ever sends it over
   * HTTPS. Defaults to on in production and must stay on for a real
   * deployment.
   *
   * The one reason to turn it off is a trial over plain HTTP on a laptop or a
   * classroom LAN: a browser will not store a Secure cookie from
   * http://192.168.x.x, so nobody can sign in. Never set this to false on a
   * machine reachable from the internet.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

/** Secure cookies unless explicitly disabled for a plain-HTTP trial. */
export const cookieSecure = env.COOKIE_SECURE ?? isProd;

if (isProd && env.COOKIE_SECURE === false) {
  console.warn(
    '[env] COOKIE_SECURE=false: session cookies will be sent over plain HTTP. ' +
      'This is only safe on a private machine or LAN - never on a public server.',
  );
}
