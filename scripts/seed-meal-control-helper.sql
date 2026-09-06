INSERT INTO "meal_control_helper" (
  "mess_id",
  "breakfast_enabled",
  "lunch_enabled",
  "dinner_enabled",
  "breakfast_start_window",
  "breakfast_end_window",
  "lunch_start_window",
  "lunch_end_window",
  "dinner_start_window",
  "dinner_end_window"
)
SELECT
  "id",
  true,
  true,
  true,
  '04:00',
  '08:00',
  '08:00',
  '13:00',
  '13:00',
  '17:00'
FROM "messes"
ON CONFLICT ("mess_id") DO NOTHING;
