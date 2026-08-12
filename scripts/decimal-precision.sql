-- Safe, data-preserving migration for decimal meal and deposit values.
-- Run this once in your PostgreSQL/Neon SQL editor.
--
-- Existing integer values are retained exactly and become values such as
-- 1.000. No rows or tables are deleted by these statements.

ALTER TABLE meals
  ALTER COLUMN count TYPE numeric(12, 3)
  USING count::numeric(12, 3);

ALTER TABLE deposits
  ALTER COLUMN amount TYPE numeric(14, 3)
  USING amount::numeric(14, 3);

ALTER TABLE deposit_entries
  ALTER COLUMN amount TYPE numeric(14, 3)
  USING amount::numeric(14, 3);
