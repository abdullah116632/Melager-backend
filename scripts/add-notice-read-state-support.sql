-- Persistent unread-notice tracking.
-- Run once in the PostgreSQL/Neon SQL editor on databases that already have
-- the notices table.

BEGIN;

CREATE TABLE IF NOT EXISTS "notice_read_states" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "last_read_notice_id" integer,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "notice_read_states_mess_user_uq" UNIQUE ("mess_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "notice_read_states_user_idx"
ON "notice_read_states" ("user_id");

-- Existing notices are already known to existing members, so begin from the
-- current latest notice instead of showing historical notices as unread.
INSERT INTO "notice_read_states" ("mess_id", "user_id", "last_read_notice_id")
SELECT
  c."mess_id",
  c."user_id",
  MAX(n."id")
FROM "consumers" c
LEFT JOIN "notices" n ON n."mess_id" = c."mess_id"
WHERE c."user_id" IS NOT NULL AND c."account_deleted_at" IS NULL
GROUP BY c."mess_id", c."user_id"
ON CONFLICT ("mess_id", "user_id") DO NOTHING;

COMMIT;
