-- Who put each question into the bank.
--
-- Questions are visible to their author and to a holder of admins.manage, so
-- two colleagues preparing different papers stop seeing each other's drafts.
--
-- Nullable on purpose. Rows that predate this column are backfilled from the
-- generation run that produced them, which is an exact answer where it exists;
-- anything left over - hand-imported before runs were recorded - keeps NULL and
-- is treated as belonging to everybody. Assigning those to whoever happens to
-- hold an account would be a guess, and a guess here hides someone's work from
-- them.

ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "createdById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Question_createdById_fkey'
  ) THEN
    ALTER TABLE "Question"
      ADD CONSTRAINT "Question_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Question_createdById_status_idx" ON "Question"("createdById", status);

-- Backfill from the run that generated or imported them.
UPDATE "Question" q
   SET "createdById" = r."requestedById"
  FROM "GenerationRun" r
 WHERE q."generationRunId" = r.id
   AND q."createdById" IS NULL;
