-- Stops the same item name appearing twice on one day's bazar list.
-- Run once in the PostgreSQL/Neon SQL editor when not using `npm run db:push`.
--
-- NOTE: this DELETES existing exact duplicates (same mess, same date, same
-- name), keeping the oldest row of each group. Check what would go first:
--
--   SELECT mess_id, bazar_date, name, count(*)
--   FROM "bazar_items"
--   GROUP BY mess_id, bazar_date, name HAVING count(*) > 1;

BEGIN;

DELETE FROM "bazar_items" AS a
USING "bazar_items" AS b
WHERE a."mess_id" = b."mess_id"
  AND a."bazar_date" = b."bazar_date"
  AND a."name" = b."name"
  AND a."id" > b."id";

ALTER TABLE "bazar_items"
  ADD CONSTRAINT "bazar_items_mess_date_name_uq"
  UNIQUE ("mess_id", "bazar_date", "name");

COMMIT;
