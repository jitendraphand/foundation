-- The expiry sweep runs every minute for the life of the deployment and looks
-- for attempts still in progress past their deadline. Without this index that
-- is a walk of the whole status index - unnoticeable on a new install, and
-- linear in the school's entire attempt history by the third year.
CREATE INDEX IF NOT EXISTS "Attempt_status_expiresAt_idx" ON "Attempt"("status", "expiresAt");
