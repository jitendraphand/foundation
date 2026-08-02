import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ENCRYPTION_KEY: z.string().min(16, 'ENCRYPTION_KEY must be at least 16 characters'),
  BACKUP_PASSPHRASE: z.string().min(8).default('foundation-backup'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('foundation_123'),
  SESSION_TTL_MINUTES: z.coerce.number().default(720),
  BACKUP_RETENTION_DAYS: z.coerce.number().default(7),
  LLM_TIMEOUT_MS: z.coerce.number().default(180_000),
  PUBLIC_HOST: z.string().default('localhost'),
  UPLOAD_DIR: z.string().default('/app/uploads'),
  BACKUP_DIR: z.string().default('/app/backups'),
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
