-- Chat file limits and Cloudflare R2 storage. One row per file a member sent
-- (or is about to send) in the chat. The rows are what the daily limits
-- count: every file counts against its mess's daily limit, and files kept in
-- R2 (`stored`) also count against the global daily limit that protects the
-- R2 free tier. The file itself lives in R2 and is deleted there by the
-- bucket's lifecycle rule, never through this table.
--
-- A new table only, so the currently deployed backend, which never reads it,
-- keeps working unchanged. Safe to re-run. Run this BEFORE deploying the
-- backend build that uses it.
BEGIN;

CREATE TABLE IF NOT EXISTS message_file_uploads (
  -- The attachment id the phone generated; also names the object in R2.
  file_id text PRIMARY KEY,
  mess_id integer NOT NULL REFERENCES messes(id) ON DELETE CASCADE,
  uploader_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  -- The day (Asia/Dhaka) this file counts against.
  usage_date date NOT NULL,
  -- True when the phone was allowed to put the file in R2.
  stored boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  -- After this the lifecycle rule may have removed the object.
  expires_at timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS message_file_uploads_date_mess_idx
  ON message_file_uploads (usage_date, mess_id);

COMMIT;
