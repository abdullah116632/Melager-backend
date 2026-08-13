ALTER TABLE "consumers"
ADD COLUMN IF NOT EXISTS "account_deleted_at" timestamp;

CREATE TABLE IF NOT EXISTS "account_deletion_otps" (
  "id" serial PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "otp" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "account_deletion_otps_email_idx"
ON "account_deletion_otps" ("email");
