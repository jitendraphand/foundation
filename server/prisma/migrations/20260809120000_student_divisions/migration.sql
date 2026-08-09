-- A student can belong to more than one division.
--
-- The school runs a Science Foundation and a Sports Foundation, and children
-- are in both. A single division column made that unrepresentable: a test set
-- for Sports Foundation simply did not reach a child filed under Science.
--
-- The existing "division" column stays, and stays authoritative for one thing:
-- the roll number is unique within a class - roll 12 of grade 8, division A -
-- and a *set* of divisions cannot carry that constraint. So "division" is the
-- home division, and "divisions" is every division the child is in, home
-- division first. Application code keeps the two in step; see setDivisions in
-- routes/admin/users.ts.
--
-- Backfilled from the existing value, so every student keeps exactly the
-- membership they already had and nothing changes for anyone until an admin
-- adds a second division by hand.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "divisions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "User"
   SET "divisions" = ARRAY["division"]
 WHERE cardinality("divisions") = 0
   AND "division" <> '';

-- Membership is looked up per request on the student dashboard - "which tests
-- and activities am I eligible for" - so the containment operator needs an
-- index rather than a sequential scan of every child in the school.
CREATE INDEX IF NOT EXISTS "User_divisions_idx" ON "User" USING GIN ("divisions");
