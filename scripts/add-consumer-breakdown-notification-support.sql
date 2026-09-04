-- Dedicated unread state for Consumer Breakdown alerts.
-- Run once in the PostgreSQL/Neon SQL editor when not using `npm run db:push`.

BEGIN;

CREATE TABLE IF NOT EXISTS "consumer_breakdown_notifications" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "read_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "consumer_breakdown_notifications_user_idx"
ON "consumer_breakdown_notifications" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "consumer_breakdown_notifications_mess_user_idx"
ON "consumer_breakdown_notifications" ("mess_id", "user_id");

COMMIT;
