import "dotenv/config";
import { pool } from "../db/index.js";

type LegacySchedule = {
  mess_id: number;
  date: string;
  breakfast_enabled: boolean;
  breakfast_menu: string | null;
  breakfast_opt_out_start: string | null;
  breakfast_opt_out_end: string | null;
  lunch_enabled: boolean;
  lunch_menu: string | null;
  lunch_opt_out_start: string | null;
  lunch_opt_out_end: string | null;
  dinner_enabled: boolean;
  dinner_menu: string | null;
  dinner_opt_out_start: string | null;
  dinner_opt_out_end: string | null;
};

type LegacyControl = {
  id: number;
  mess_id: number;
  date: string;
  meal_type: "breakfast" | "lunch" | "dinner";
  enabled: boolean;
  opt_out_start: string | null;
  opt_out_end: string | null;
  scope: "day" | "ongoing";
};

const key = (messId: number, date: string) => `${messId}:${date}`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE meal_control IN ACCESS EXCLUSIVE MODE");
    await client.query("LOCK TABLE meal_schedule IN ACCESS EXCLUSIVE MODE");

    const schedules = (await client.query<LegacySchedule>("SELECT * FROM meal_schedule")).rows;
    const controls = (await client.query<LegacyControl>("SELECT * FROM meal_control")).rows;
    const scheduleByDate = new Map(schedules.map((row) => [key(row.mess_id, row.date), row]));
    const defaultByMess = new Map(
      schedules.filter((row) => row.date === "__default__").map((row) => [row.mess_id, row]),
    );
    const dateKeys = new Set([
      ...schedules.map((row) => key(row.mess_id, row.date)),
      ...controls.map((row) => key(row.mess_id, row.date)),
    ]);

    await client.query(`
      CREATE TABLE meal_control_daily_new (
        id serial PRIMARY KEY,
        mess_id integer NOT NULL REFERENCES messes(id),
        date text NOT NULL,
        breakfast_enabled boolean NOT NULL DEFAULT true,
        lunch_enabled boolean NOT NULL DEFAULT true,
        dinner_enabled boolean NOT NULL DEFAULT true,
        breakfast_start_window text,
        breakfast_end_window text,
        lunch_start_window text,
        lunch_end_window text,
        dinner_start_window text,
        dinner_end_window text,
        breakfast_menu text,
        lunch_menu text,
        dinner_menu text,
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT meal_control_daily_new_mess_date_uq UNIQUE (mess_id, date)
      )
    `);
    await client.query("CREATE INDEX meal_control_daily_new_mess_date_idx ON meal_control_daily_new (mess_id, date)");

    const findControl = (
      messId: number,
      date: string,
      mealType: LegacyControl["meal_type"],
    ) => {
      const exact = controls
        .filter((row) => row.mess_id === messId && row.date === date && row.meal_type === mealType && row.scope === "day")
        .sort((a, b) => b.id - a.id)[0];
      if (exact) return exact;
      return controls
        .filter((row) => row.mess_id === messId && row.date <= date && row.meal_type === mealType && row.scope === "ongoing")
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)[0];
    };

    for (const compositeKey of [...dateKeys].sort()) {
      const separator = compositeKey.indexOf(":");
      const messId = Number(compositeKey.slice(0, separator));
      const date = compositeKey.slice(separator + 1);
      const schedule = scheduleByDate.get(compositeKey) ?? defaultByMess.get(messId);
      const breakfast = date === "__default__" ? undefined : findControl(messId, date, "breakfast");
      const lunch = date === "__default__" ? undefined : findControl(messId, date, "lunch");
      const dinner = date === "__default__" ? undefined : findControl(messId, date, "dinner");
      const exactSchedule = scheduleByDate.get(compositeKey);

      await client.query(
        `INSERT INTO meal_control_daily_new (
          mess_id, date,
          breakfast_enabled, lunch_enabled, dinner_enabled,
          breakfast_start_window, breakfast_end_window,
          lunch_start_window, lunch_end_window,
          dinner_start_window, dinner_end_window,
          breakfast_menu, lunch_menu, dinner_menu
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          messId,
          date,
          breakfast?.enabled ?? schedule?.breakfast_enabled ?? true,
          lunch?.enabled ?? schedule?.lunch_enabled ?? true,
          dinner?.enabled ?? schedule?.dinner_enabled ?? true,
          breakfast ? breakfast.opt_out_start : schedule?.breakfast_opt_out_start ?? null,
          breakfast ? breakfast.opt_out_end : schedule?.breakfast_opt_out_end ?? null,
          lunch ? lunch.opt_out_start : schedule?.lunch_opt_out_start ?? null,
          lunch ? lunch.opt_out_end : schedule?.lunch_opt_out_end ?? null,
          dinner ? dinner.opt_out_start : schedule?.dinner_opt_out_start ?? null,
          dinner ? dinner.opt_out_end : schedule?.dinner_opt_out_end ?? null,
          exactSchedule?.breakfast_menu ?? null,
          exactSchedule?.lunch_menu ?? null,
          exactSchedule?.dinner_menu ?? null,
        ],
      );
    }

    await client.query("ALTER TABLE meal_control RENAME TO meal_control_per_meal_backup");
    await client.query("ALTER TABLE meal_schedule RENAME TO meal_schedule_backup");
    await client.query("ALTER TABLE meal_control_daily_new RENAME TO meal_control");
    await client.query("COMMIT");
    console.log(`Migrated ${dateKeys.size} daily meal-control rows`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
