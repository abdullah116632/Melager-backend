import { pool } from "../db/dbConfig.js";

const client = await pool.connect();

try {
  await client.query("begin");
  await client.query(`
    alter table meal_opt_outs
      add column if not exists scope text not null default 'day'
  `);
  await client.query(`
    alter table meal_opt_outs
      add column if not exists ended_date text
  `);
  await client.query(`
    create index if not exists meal_opt_outs_ongoing_idx
      on meal_opt_outs (mess_id, consumer_id, meal_type, scope)
  `);
  await client.query("commit");
  console.log("Meal opt-out scope migration applied.");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
