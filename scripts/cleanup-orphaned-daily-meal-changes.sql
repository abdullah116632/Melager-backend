-- Removes daily-meal change-feed rows that belong to members who are no
-- longer in their mess. Deleting a member used to remove their meals but leave
-- these rows behind, so a phone pulling a month from the start (fresh install,
-- cleared data) replayed the removed member's meals and the summary cards
-- counted them.
--
-- Data cleanup only; no schema change. Safe to re-run, and safe to run before
-- or after deploying the backend that cleans these rows up on delete.
--
-- Optional preview of what will be removed:
--   SELECT mess_id, payload->>'consumerId' AS consumer_id, count(*)
--   FROM sync_changes s
--   WHERE s.entity_type = 'daily_meal'
--     AND NOT EXISTS (
--       SELECT 1 FROM consumers c
--       WHERE c.id::text = s.payload->>'consumerId' AND c.mess_id = s.mess_id
--     )
--   GROUP BY 1, 2 ORDER BY 1, 2;
BEGIN;

DELETE FROM sync_changes s
WHERE s.entity_type = 'daily_meal'
  AND NOT EXISTS (
    SELECT 1 FROM consumers c
    WHERE c.id::text = s.payload->>'consumerId'
      AND c.mess_id = s.mess_id
  );

COMMIT;