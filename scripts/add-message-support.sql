CREATE TABLE IF NOT EXISTS "messages" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id") ON DELETE CASCADE,
  "sender_user_id" integer NOT NULL REFERENCES "users"("id"),
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "messages_mess_created_id_idx"
ON "messages" ("mess_id", "created_at", "id");

DROP INDEX IF EXISTS "messages_mess_created_idx";

CREATE INDEX IF NOT EXISTS "messages_sender_created_idx"
ON "messages" ("sender_user_id", "created_at");