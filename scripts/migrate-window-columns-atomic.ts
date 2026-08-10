import "dotenv/config";
import { pool } from "../db/dbConfig.js";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE meal_control IN ACCESS EXCLUSIVE MODE");
    await client.query(`
      ALTER TABLE meal_control
        ADD COLUMN IF NOT EXISTS breakfast_start_window text,
        ADD COLUMN IF NOT EXISTS breakfast_end_window text,
        ADD COLUMN IF NOT EXISTS lunch_start_window text,
        ADD COLUMN IF NOT EXISTS lunch_end_window text,
        ADD COLUMN IF NOT EXISTS dinner_start_window text,
        ADD COLUMN IF NOT EXISTS dinner_end_window text
    `);
    await client.query(`
      UPDATE meal_control SET
        breakfast_start_window = breakfast_window ->> 'start',
        breakfast_end_window = breakfast_window ->> 'end',
        lunch_start_window = lunch_window ->> 'start',
        lunch_end_window = lunch_window ->> 'end',
        dinner_start_window = dinner_window ->> 'start',
        dinner_end_window = dinner_window ->> 'end'
    `);

    const verification = await client.query<{ mismatches: number }>(`
      SELECT count(*)::int AS mismatches
      FROM meal_control
      WHERE (breakfast_window ->> 'start') IS DISTINCT FROM breakfast_start_window
         OR (breakfast_window ->> 'end') IS DISTINCT FROM breakfast_end_window
         OR (lunch_window ->> 'start') IS DISTINCT FROM lunch_start_window
         OR (lunch_window ->> 'end') IS DISTINCT FROM lunch_end_window
         OR (dinner_window ->> 'start') IS DISTINCT FROM dinner_start_window
         OR (dinner_window ->> 'end') IS DISTINCT FROM dinner_end_window
    `);
    if ((verification.rows[0]?.mismatches ?? 1) !== 0) {
      throw new Error(
        "Window-column verification failed; JSON columns were retained",
      );
    }

    await client.query(`
      ALTER TABLE meal_control
        DROP COLUMN breakfast_window,
        DROP COLUMN lunch_window,
        DROP COLUMN dinner_window
    `);
    await client.query("COMMIT");
    console.log(
      "Migrated meal windows from 3 JSON columns to 6 atomic text columns",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
