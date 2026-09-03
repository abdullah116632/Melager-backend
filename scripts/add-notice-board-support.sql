CREATE TABLE IF NOT EXISTS "notices" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id"),
  "serial_no" integer NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "notices_mess_serial_uq" UNIQUE ("mess_id", "serial_no")
);

ALTER TABLE "notices"
ADD COLUMN IF NOT EXISTS "color" text NOT NULL DEFAULT '#FFFFFF';

ALTER TABLE "notices"
ALTER COLUMN "color" SET DEFAULT '#FFFFFF';

CREATE INDEX IF NOT EXISTS "notices_mess_serial_idx"
ON "notices" ("mess_id", "serial_no");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "notice_id" integer REFERENCES "notices"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "read_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_created_idx"
ON "notifications" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "notifications_mess_created_idx"
ON "notifications" ("mess_id", "created_at");
