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
  BACKUP_RETENTION_DAYS: z.coerce.number().default(7),
  LLM_TIMEOUT_MS: z.coerce.number().default(180_000),
  PUBLIC_HOST: z.string().default('localhost'),
  UPLOAD_DIR: z.string().default('/app/uploads'),
  BACKUP_DIR: z.string().default('/app/backups'),

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
