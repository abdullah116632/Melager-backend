CREATE TABLE IF NOT EXISTS "bazar_items" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id"),
  "weekday" integer NOT NULL,
  "name" text NOT NULL,
  "price" numeric(14, 3) NOT NULL DEFAULT 0,
  "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "bazar_items_mess_weekday_idx"
ON "bazar_items" ("mess_id", "weekday");

CREATE INDEX IF NOT EXISTS "bazar_items_mess_idx"
ON "bazar_items" ("mess_id");

ALTER TABLE "bazar_items"
  ADD COLUMN IF NOT EXISTS "is_completed" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "bazar_assignments" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id"),
  "weekday" integer NOT NULL,
  "consumer_id" integer NOT NULL REFERENCES "consumers"("id") ON DELETE CASCADE,
  "assigned_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "bazar_assignments_mess_weekday_consumer_uq"
    UNIQUE ("mess_id", "weekday", "consumer_id")
);

CREATE INDEX IF NOT EXISTS "bazar_assignments_mess_weekday_idx"
ON "bazar_assignments" ("mess_id", "weekday");
