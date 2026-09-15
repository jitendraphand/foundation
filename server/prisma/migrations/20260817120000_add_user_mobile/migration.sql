-- Add mobile number for WhatsApp password reset. Only System Administrator may set it.
-- Nullable and no unique constraint, so existing rows (including old backups) migrate cleanly.
ALTER TABLE "User" ADD COLUMN "mobile" TEXT;

-- Partial index for lookup by mobile; partial indexes are invisible to
-- Prisma's drift check, which is fine — this is planner-only.
CREATE INDEX IF NOT EXISTS "User_mobile_idx" ON "User" ("mobile") WHERE "mobile" IS NOT NULL;
