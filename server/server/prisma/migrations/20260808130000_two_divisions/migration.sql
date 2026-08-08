-- The school runs two streams - Science Foundation and Sports Foundation -
-- rather than lettered classes.
--
-- The lettered divisions are retired rather than deleted. Deleting one that a
-- student is assigned to would leave that student pointing at a division which
-- no longer exists, and their past results are filed under it. Retiring takes
-- it off the signup form and out of the audience pickers while leaving every
-- existing record intact; an administrator can reassign those students and
-- then remove the empty division from Settings.
--
-- A lettered division nobody is in is simply switched off.

INSERT INTO "SchoolClass" (id, kind, code, label, "sortOrder", "isActive", "createdAt", meta)
VALUES
  (gen_random_uuid(), 'DIVISION', 'SCIENCE', 'Science Foundation', 1, true, now(), '{}'),
  (gen_random_uuid(), 'DIVISION', 'SPORTS',  'Sports Foundation',  2, true, now(), '{}')
ON CONFLICT (kind, code) DO UPDATE
  SET label = EXCLUDED.label, "sortOrder" = EXCLUDED."sortOrder", "isActive" = true;

-- Push the lettered ones below the two real streams so they never head the list.
UPDATE "SchoolClass"
   SET "isActive" = false, "sortOrder" = "sortOrder" + 100
 WHERE kind = 'DIVISION'
   AND code NOT IN ('SCIENCE', 'SPORTS', 'STAFF')
   AND NOT EXISTS (
     SELECT 1 FROM "User" u WHERE u.division = "SchoolClass".code AND u."deletedAt" IS NULL
   );

-- One still carrying students stays selectable, but is clearly marked so an
-- administrator can see there is tidying left to do.
UPDATE "SchoolClass"
   SET label = label || ' (retiring - reassign these students)'
 WHERE kind = 'DIVISION'
   AND code NOT IN ('SCIENCE', 'SPORTS', 'STAFF')
   AND label NOT LIKE '%retiring%'
   AND EXISTS (
     SELECT 1 FROM "User" u WHERE u.division = "SchoolClass".code AND u."deletedAt" IS NULL
   );
