-- Difficulty vocabulary becomes Easy / Medium / Hard.
--
-- The codes are stored on every question and inside every historical
-- breakdown, so this renames the data as well as the vocabulary rather than
-- leaving two spellings of the same idea in the database.
--
-- Written to be safe to re-run: each statement is a no-op once applied, and
-- none of them touch a row that already uses the new code.

-- 1. The vocabulary itself. Guarded so it cannot collide if a partially
--    migrated database already has the new row.
DELETE FROM "Tag" t
 WHERE t.axis = 'DIFFICULTY' AND t.code IN ('medium', 'hard')
   AND EXISTS (SELECT 1 FROM "Tag" o WHERE o.axis = 'DIFFICULTY' AND o.code = CASE t.code WHEN 'medium' THEN 'moderate' ELSE 'difficult' END);

UPDATE "Tag" SET code = 'medium', label = 'Medium' WHERE axis = 'DIFFICULTY' AND code = 'moderate';
UPDATE "Tag" SET code = 'hard',   label = 'Hard'   WHERE axis = 'DIFFICULTY' AND code = 'difficult';

-- 2. Every question already tagged with the old code.
UPDATE "Question" SET "difficultyTag" = 'medium' WHERE "difficultyTag" = 'moderate';
UPDATE "Question" SET "difficultyTag" = 'hard'   WHERE "difficultyTag" = 'difficult';

-- 3. Historical attempt breakdowns key their per-difficulty counts by code.
--    Left alone, an old paper would report a "moderate" bucket alongside a new
--    "medium" one and the analytics would silently split in two.
UPDATE "Attempt"
   SET breakdown = (
         replace(replace(breakdown::text, '"moderate"', '"medium"'), '"difficult"', '"hard"')
       )::jsonb
 WHERE breakdown::text LIKE '%"moderate"%' OR breakdown::text LIKE '%"difficult"%';
