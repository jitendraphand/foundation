-- Add per-question time limit override for tests
-- This allows admins to set a specific time limit (in seconds) for each question
-- when configuring a test, overriding the question's estimatedSeconds default.
-- When not set (NULL), the question's estimatedSeconds is used as before.
--
ALTER TABLE "TestQuestion" ADD COLUMN "timeLimitSeconds" INTEGER;

-- Comment: Per-question time limit in seconds. Falls back to the question's
-- `estimatedSeconds` when not set, so existing tests keep working without
-- changes to the question bank.
COMMENT ON COLUMN "TestQuestion"."timeLimitSeconds" IS 'Per-question time limit override in seconds. Falls back to the question''s estimatedSeconds when not set.';