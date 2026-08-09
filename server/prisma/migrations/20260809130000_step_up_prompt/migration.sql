-- A prompt template's "kind" is which generator uses it, not what sort of test
-- comes out.
--
-- It was the TestKind enum, REGULAR or PRACTICE, which worked while those were
-- the only two generators. The Step-up Test is a third, and it cannot be added
-- to TestKind: a Step-up paper *is* a practice test - that is how it inherits
-- the exam runner, the grading, the release rules and the "practice never
-- pollutes class analytics" guarantee - so widening TestKind would put a value
-- on Test and GenerationRun that must never be used there.
--
-- So the column becomes plain text. Prompt kinds are a vocabulary that will
-- keep growing, one row at a time; test kinds are a genuinely closed set and
-- stay an enum.

ALTER TABLE "PromptTemplate" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "PromptTemplate" ALTER COLUMN "kind" TYPE TEXT USING "kind"::TEXT;
ALTER TABLE "PromptTemplate" ALTER COLUMN "kind" SET DEFAULT 'REGULAR';
