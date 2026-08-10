import { and, desc, eq, lte, ne } from "drizzle-orm";
import { db, mealControlTable } from "../db/dbConfig.js";
import { dateInAppTimeZone } from "./dateUtils.js";

const DEFAULT_DATE = "__default__";
const APP_TIME_ZONE = process.env.APP_TIME_ZONE ?? "Asia/Dhaka";

export const MEAL_TYPES = ["breakfast", "lunch", "dinner"] as const;
export const MAX_FUTURE_DAYS = 3;

export type MealType = (typeof MEAL_TYPES)[number];
export type ControlScope = "day" | "ongoing";
export type RequestedControl = {
  mealType: MealType;
  enabled: boolean;
  scope: ControlScope;
};

export const getTodayDate = (): string => dateInAppTimeZone(new Date());

export const addDays = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export const isBeyondFutureLimit = (date: string): boolean =>
  date > addDays(getTodayDate(), MAX_FUTURE_DAYS);

const timeToMinutes = (hhmm: string): number => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

export const isWithinMealOptOutWindow = (
  start: string | null,
  end: string | null,
): boolean => {
  if (!start || !end) return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((item) => item.type === "hour")?.value ?? 0);
  const minute = Number(
    parts.find((item) => item.type === "minute")?.value ?? 0,
  );
  const currentTime = hour * 60 + minute;

  return (
    currentTime >= timeToMinutes(start) && currentTime <= timeToMinutes(end)
  );
};

const getDateControl = async (messId: number, date: string) => {
  const [row] = await db
    .select()
    .from(mealControlTable)
    .where(
      and(eq(mealControlTable.messId, messId), eq(mealControlTable.date, date)),
    )
    .limit(1);
  return row ?? null;
};

const getLatestControl = async (messId: number, date: string) => {
  const [row] = await db
    .select()
    .from(mealControlTable)
    .where(
      and(
        eq(mealControlTable.messId, messId),
        ne(mealControlTable.date, DEFAULT_DATE),
        lte(mealControlTable.date, date),
      ),
    )
    .orderBy(desc(mealControlTable.date))
    .limit(1);
  if (row) return row;
  return getDateControl(messId, DEFAULT_DATE);
};

const scheduleFromControl = (
  control: Awaited<ReturnType<typeof getDateControl>>,
) => {
  const source = control ? ("day" as const) : null;

  return {
    breakfastEnabled: control?.breakfastEnabled ?? true,
    breakfastMenu: control?.breakfastMenu ?? null,
    breakfastOptOutStart: control?.breakfastOptOutStart ?? null,
    breakfastOptOutEnd: control?.breakfastOptOutEnd ?? null,
    lunchEnabled: control?.lunchEnabled ?? true,
    lunchMenu: control?.lunchMenu ?? null,
    lunchOptOutStart: control?.lunchOptOutStart ?? null,
    lunchOptOutEnd: control?.lunchOptOutEnd ?? null,
    dinnerEnabled: control?.dinnerEnabled ?? true,
    dinnerMenu: control?.dinnerMenu ?? null,
    dinnerOptOutStart: control?.dinnerOptOutStart ?? null,
    dinnerOptOutEnd: control?.dinnerOptOutEnd ?? null,
    availabilitySource: {
      breakfast: source,
      lunch: source,
      dinner: source,
    },
  };
};

export const getMergedSchedule = async (messId: number, date: string) => {
  const exact = await getDateControl(messId, date);
  if (exact) return scheduleFromControl(exact);
  const fallback = await getDateControl(messId, DEFAULT_DATE);
  return scheduleFromControl(fallback);
};

const snapshotValues = (
  messId: number,
  date: string,
  source: Awaited<ReturnType<typeof getDateControl>>,
) => ({
  messId,
  date,
  breakfastEnabled: source?.breakfastEnabled ?? true,
  lunchEnabled: source?.lunchEnabled ?? true,
  dinnerEnabled: source?.dinnerEnabled ?? true,
  breakfastOptOutStart: source?.breakfastOptOutStart ?? null,
  breakfastOptOutEnd: source?.breakfastOptOutEnd ?? null,
  lunchOptOutStart: source?.lunchOptOutStart ?? null,
  lunchOptOutEnd: source?.lunchOptOutEnd ?? null,
  dinnerOptOutStart: source?.dinnerOptOutStart ?? null,
  dinnerOptOutEnd: source?.dinnerOptOutEnd ?? null,
  // Menus describe one specific day and are deliberately not carried into
  // a newly-created future date.
  breakfastMenu: null,
  lunchMenu: null,
  dinnerMenu: null,
});

/** Materialize one compact row for each visited date from today's baseline. */
export const ensureMealControlSnapshots = async (
  messId: number,
  targetDate: string,
) => {
  const today = getTodayDate();
  if (targetDate < today) return;

  let date = today;
  while (date <= targetDate) {
    const existing = await getDateControl(messId, date);
    if (!existing) {
      // Every future date starts from today's baseline. Copying the previous
      // future date would incorrectly carry a one-day future override forward.
      const source =
        date === today
          ? await getLatestControl(messId, date)
          : await getDateControl(messId, today);
      await db
        .insert(mealControlTable)
        .values(snapshotValues(messId, date, source))
        .onConflictDoNothing({
          target: [mealControlTable.messId, mealControlTable.date],
        });
    }
    date = addDays(date, 1);
  }
};
