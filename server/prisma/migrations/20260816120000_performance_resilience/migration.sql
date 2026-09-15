-- Performance + resilience indexes for audience filtering and analytics.
-- All additive and nullable-safe; safe to run on a live database with data.
--
-- The first block is declared in schema.prisma, so `prisma migrate diff`
-- reports no drift for it and `migrate dev` will not try to remove it.
-- The second block uses partial/expression indexes, which Prisma cannot
-- model; migrate diff ignores those, and they exist purely for the planner.

-- GIN indexes for array audience filters (has / hasSome) — used on every
-- student dashboard load and activity gate. Without these, every PUBLISHED
-- test is seq-scanned.
CREATE INDEX IF NOT EXISTS "Test_targetGrades_idx" ON "Test" USING GIN ("targetGrades");
CREATE INDEX IF NOT EXISTS "Test_targetDivisions_idx" ON "Test" USING GIN ("targetDivisions");
CREATE INDEX IF NOT EXISTS "Activity_targetGrades_idx" ON "Activity" USING GIN ("targetGrades");
CREATE INDEX IF NOT EXISTS "Activity_targetDivisions_idx" ON "Activity" USING GIN ("targetDivisions");

-- Breakdown JSONB analytics: tagTallies / weakness scan breakdown->field->key.
-- Without GIN, every analytics recomputation scans all attempts.
CREATE INDEX IF NOT EXISTS "Attempt_breakdown_idx" ON "Attempt" USING GIN ("breakdown");

-- Session pruning sweep: pruneSessions deletes where revokedAt < cutoff OR
-- expiresAt < cutoff. A bare revokedAt index gives the OR an index on each side.
CREATE INDEX IF NOT EXISTS "Session_revokedAt_idx" ON "Session" ("revokedAt");

-- --- Planner-only indexes (invisible to Prisma, safe to keep) ---------------

-- Hot listing path: only PUBLISHED, non-deleted tests are student-visible.
CREATE INDEX IF NOT EXISTS "Test_published_visible_idx" ON "Test" ("status", "kind", "startsAt")
  WHERE "deletedAt" IS NULL AND "status" = 'PUBLISHED';

-- Case-insensitive subject filter in the question bank.
CREATE INDEX IF NOT EXISTS "Question_subject_lower_idx" ON "Question" (lower("subject"));

-- Generation-run drill-down; almost every row has a NULL run, so keep the
-- index to the ones that do not.
CREATE INDEX IF NOT EXISTS "Question_generationRunId_idx" ON "Question" ("generationRunId")
  WHERE "generationRunId" IS NOT NULL;
