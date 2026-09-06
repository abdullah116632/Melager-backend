CREATE TABLE IF NOT EXISTS "meal_control_helper" (
  "id" serial PRIMARY KEY,
  "mess_id" integer NOT NULL REFERENCES "messes"("id"),
  "breakfast_enabled" boolean NOT NULL DEFAULT true,
  "lunch_enabled" boolean NOT NULL DEFAULT true,
  "dinner_enabled" boolean NOT NULL DEFAULT true,
  "breakfast_start_window" text,
  "breakfast_end_window" text,
  "lunch_start_window" text,
  "lunch_end_window" text,
  "dinner_start_window" text,
  "dinner_end_window" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "meal_control_helper_mess_uq"
    UNIQUE ("mess_id")
);

CREATE INDEX IF NOT EXISTS "meal_control_helper_mess_idx"
ON "meal_control_helper" ("mess_id");
