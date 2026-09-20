-- Bookkeeping for the nightly "your bazar duty is tomorrow" push.
-- Purely additive: no existing table or column is touched, so older app
-- versions keep working unchanged.
-- Run once in the PostgreSQL/Neon SQL editor when not using `npm run db:push`.

BEGIN;

CREATE TABLE IF NOT EXISTS "bazar_duty_reminders" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "bazar_date" text NOT NULL,
  "sent_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "bazar_duty_reminders_mess_user_date_uq"
    UNIQUE ("mess_id", "user_id", "bazar_date")
);

COMMIT;
