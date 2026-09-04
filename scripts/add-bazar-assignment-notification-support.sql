-- Dedicated unread state for Bazar-duty alerts.
-- Run once in the PostgreSQL/Neon SQL editor when not using `npm run db:push`.

BEGIN;

CREATE TABLE IF NOT EXISTS "bazar_assignment_notifications" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "weekday" integer NOT NULL,
  "read_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "bazar_assignment_notifications_user_idx"
ON "bazar_assignment_notifications" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "bazar_assignment_notifications_mess_user_idx"
ON "bazar_assignment_notifications" ("mess_id", "user_id");

-- Earlier versions stored these in the shared bell notification table.
-- Remove them so they no longer appear in the bell count/panel.
DELETE FROM "notifications" WHERE "type" = 'bazar_assignment';

COMMIT;
