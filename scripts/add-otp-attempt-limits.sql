-- Attempt counters for the remaining OTP challenges.
-- `account_deletion_otps` already shipped with this column; these three tables
-- accepted unlimited guesses, which made a six-digit password-reset code
-- brute-forceable inside its ten-minute window.
--
-- Run once in the PostgreSQL/Neon SQL editor. Every column carries a default,
-- so an older API build that does not know about it keeps inserting normally.

BEGIN;

ALTER TABLE "password_resets"
ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "otp_verifications"
ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "security_otps"
ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

COMMIT;
