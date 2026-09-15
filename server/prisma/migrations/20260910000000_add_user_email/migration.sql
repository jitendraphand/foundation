-- Add email address for email password reset. Only System Administrator may set it.
-- Nullable and no unique constraint, so existing rows (including old backups) migrate cleanly.
ALTER TABLE "User" ADD COLUMN "email" TEXT;

-- Partial index for lookup by email; partial indexes are invisible to
-- Prisma's drift check, which is fine — this is planner-only.
CREATE INDEX IF NOT EXISTS "User_email_idx" ON "User" ("email") WHERE "email" IS NOT NULL;
