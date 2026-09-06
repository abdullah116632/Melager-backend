-- Keep one helper row per mess before removing the old date dimension.
DELETE FROM "meal_control_helper" helper
USING "meal_control_helper" duplicate
WHERE helper."mess_id" = duplicate."mess_id"
  AND helper."id" > duplicate."id";

ALTER TABLE "meal_control_helper"
  DROP CONSTRAINT IF EXISTS "meal_control_helper_mess_date_uq";

DROP INDEX IF EXISTS "meal_control_helper_mess_date_idx";

ALTER TABLE "meal_control_helper"
  DROP COLUMN IF EXISTS "date";

ALTER TABLE "meal_control_helper"
  ADD CONSTRAINT "meal_control_helper_mess_uq"
  UNIQUE ("mess_id");

CREATE INDEX IF NOT EXISTS "meal_control_helper_mess_idx"
ON "meal_control_helper" ("mess_id");