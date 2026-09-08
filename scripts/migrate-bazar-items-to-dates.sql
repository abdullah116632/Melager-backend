-- Moves bazar items from a weekly template to per-date lists.
-- Bazar duty assignments stay weekday based and are intentionally untouched.
-- Run once in the PostgreSQL/Neon SQL editor when not using `npm run db:push`.

BEGIN;

-- Existing rows only knew a weekday (0 = Saturday ... 6 = Friday), so they are
-- parked on the next occurrence of that weekday from today.
ALTER TABLE "bazar_items" ADD COLUMN IF NOT EXISTS "bazar_date" text;

UPDATE "bazar_items"
SET "bazar_date" = to_char(
  CURRENT_DATE
    + (("weekday" - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) + 7) % 7),
  'YYYY-MM-DD'
)
WHERE "bazar_date" IS NULL;

ALTER TABLE "bazar_items" ALTER COLUMN "bazar_date" SET NOT NULL;
DROP INDEX IF EXISTS "bazar_items_mess_weekday_idx";
ALTER TABLE "bazar_items" DROP COLUMN IF EXISTS "weekday";

CREATE INDEX IF NOT EXISTS "bazar_items_mess_date_idx"
ON "bazar_items" ("mess_id", "bazar_date");

ALTER TABLE "bazar_assignment_notifications"
  ADD COLUMN IF NOT EXISTS "bazar_date" text;

UPDATE "bazar_assignment_notifications"
SET "bazar_date" = to_char(
  CURRENT_DATE
    + (("weekday" - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7) + 7) % 7),
  'YYYY-MM-DD'
)
WHERE "bazar_date" IS NULL;

ALTER TABLE "bazar_assignment_notifications"
  ALTER COLUMN "bazar_date" SET NOT NULL;
ALTER TABLE "bazar_assignment_notifications" DROP COLUMN IF EXISTS "weekday";

COMMIT;
