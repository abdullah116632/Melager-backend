UPDATE "meal_control_helper"
SET
  "breakfast_start_window" = COALESCE("breakfast_start_window", '04:00'),
  "breakfast_end_window" = COALESCE("breakfast_end_window", '08:00'),
  "lunch_start_window" = COALESCE("lunch_start_window", '08:00'),
  "lunch_end_window" = COALESCE("lunch_end_window", '13:00'),
  "dinner_start_window" = COALESCE("dinner_start_window", '13:00'),
  "dinner_end_window" = COALESCE("dinner_end_window", '17:00'),
  "breakfast_enabled" = COALESCE("breakfast_enabled", true),
  "lunch_enabled" = COALESCE("lunch_enabled", true),
  "dinner_enabled" = COALESCE("dinner_enabled", true);