-- A meal_control row can be created only for a date-specific menu. Availability
-- and on/off-window values inherit independently from meal_control_helper
-- unless an admin explicitly edits that value for the date.
ALTER TABLE "meal_control"
  ADD COLUMN IF NOT EXISTS "breakfast_enabled_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "breakfast_window_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lunch_enabled_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lunch_window_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dinner_enabled_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dinner_window_override" boolean NOT NULL DEFAULT false;
