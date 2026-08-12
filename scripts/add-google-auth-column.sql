-- Google authentication support for Melager.
-- Safe to run once in Neon SQL Editor or any PostgreSQL client.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "google_subject" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_google_subject_unique'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_google_subject_unique" UNIQUE ("google_subject");
  END IF;
END $$;
