import { Router } from "express";
import { and, desc, eq, gt, lte, ne } from "drizzle-orm";
import {
  db,
  consumersTable,
  mealControlTable,
  mealOptOutsTable,
} from "../../db/index.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getMessContext } from "../lib/mess-access.js";

const router = Router();

const DEFAULT_DATE = "__default__";
const MEAL_TYPES = ["breakfast", "lunch", "dinner"] as const;
type MealType = (typeof MEAL_TYPES)[number];
type ControlScope = "day" | "ongoing";
type RequestedControl = { mealType: MealType; enabled: boolean; scope: ControlScope };
const APP_TIME_ZONE = process.env.APP_TIME_ZONE ?? "Asia/Dhaka";
const MAX_FUTURE_DAYS = 3;

function todayDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isBeyondFutureLimit(date: string): boolean {
  return date > addDays(todayDate(), MAX_FUTURE_DAYS);
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isWithinWindow(start: string | null, end: string | null): boolean {
  if (!start || !end) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((item) => item.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((item) => item.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  return current >= timeToMinutes(start) && current <= timeToMinutes(end);
}

async function getDateControl(messId: number, date: string) {
  const [row] = await db
    .select()
    .from(mealControlTable)
    .where(and(eq(mealControlTable.messId, messId), eq(mealControlTable.date, date)))
    .limit(1);
  return row ?? null;
}

async function getLatestControl(messId: number, date: string) {
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
}

function scheduleFromControl(control: Awaited<ReturnType<typeof getDateControl>>) {
  const source = control ? "day" as const : null;

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
}

async function getMergedSchedule(messId: number, date: string) {
  const exact = await getDateControl(messId, date);
  if (exact) return scheduleFromControl(exact);
  const fallback = await getDateControl(messId, DEFAULT_DATE);
  return scheduleFromControl(fallback);
}

function snapshotValues(
  messId: number,
  date: string,
  source: Awaited<ReturnType<typeof getDateControl>>,
) {
  return {
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
  };
}

/** Materialize one compact row for each visited date from today's baseline. */
async function ensureMealControlSnapshots(messId: number, targetDate: string) {
  const today = todayDate();
  if (targetDate < today) return;

  let date = today;
  while (date <= targetDate) {
    const existing = await getDateControl(messId, date);
    if (!existing) {
      // Every future date starts from today's baseline. Copying the previous
      // future date would incorrectly carry a one-day future override forward.
      const source = date === today
        ? await getLatestControl(messId, date)
        : await getDateControl(messId, today);
      await db
        .insert(mealControlTable)
        .values(snapshotValues(messId, date, source))
        .onConflictDoNothing({ target: [mealControlTable.messId, mealControlTable.date] });
    }
    date = addDays(date, 1);
  }
}

// GET /api/mess/today-schedule?messId=X[&date=YYYY-MM-DD]
router.get("/mess/today-schedule", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = parseInt(req.query.messId as string, 10);
  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }

  const { mess, consumerId } = await getMessContext(userId, messId);
  if (!mess) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const date = (req.query.date as string) || todayDate();
  if (isBeyondFutureLimit(date)) {
    res.status(400).json({ error: `Only the next ${MAX_FUTURE_DAYS} days are available` });
    return;
  }
  await ensureMealControlSnapshots(messId, date);

  const [schedule, allConsumers, optOutRows] = await Promise.all([
    getMergedSchedule(messId, date),
    db.select({ id: consumersTable.id }).from(consumersTable).where(eq(consumersTable.messId, messId)),
    db
      .select()
      .from(mealOptOutsTable)
      .where(and(eq(mealOptOutsTable.messId, messId), eq(mealOptOutsTable.date, date))),
  ]);

  const totalConsumers = allConsumers.length;
  const myOptOuts = consumerId
    ? optOutRows.filter((item) => item.consumerId === consumerId).map((item) => item.mealType)
    : [];
  const optOutCountByMeal: Record<string, number> = {};
  for (const item of optOutRows) {
    optOutCountByMeal[item.mealType] = (optOutCountByMeal[item.mealType] ?? 0) + 1;
  }

  const activeByMeal = {
    breakfast: schedule.breakfastEnabled ? Math.max(0, totalConsumers - (optOutCountByMeal.breakfast ?? 0)) : 0,
    lunch: schedule.lunchEnabled ? Math.max(0, totalConsumers - (optOutCountByMeal.lunch ?? 0)) : 0,
    dinner: schedule.dinnerEnabled ? Math.max(0, totalConsumers - (optOutCountByMeal.dinner ?? 0)) : 0,
  };

  res.json({
    date,
    schedule,
    myOptOuts,
    totalConsumers,
    activeByMeal,
    totalActive: activeByMeal.breakfast + activeByMeal.lunch + activeByMeal.dinner,
  });
});

// PUT /api/mess/meal-schedule — admin updates one daily control row
router.put("/mess/meal-schedule", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const {
    messId: messIdRaw,
    date,
    breakfastEnabled,
    breakfastMenu,
    breakfastOptOutStart,
    breakfastOptOutEnd,
    lunchEnabled,
    lunchMenu,
    lunchOptOutStart,
    lunchOptOutEnd,
    dinnerEnabled,
    dinnerMenu,
    dinnerOptOutStart,
    dinnerOptOutEnd,
    mealControls,
  } = req.body ?? {};

  const messId = parseInt(messIdRaw, 10);
  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const targetDate = (date as string) ?? todayDate();
  const today = todayDate();
  if (targetDate < today) {
    res.status(403).json({ error: "Past meal schedules are read-only" });
    return;
  }
  if (isBeyondFutureLimit(targetDate)) {
    res.status(400).json({ error: `Meal schedules can only be set up to ${MAX_FUTURE_DAYS} days ahead` });
    return;
  }

  await ensureMealControlSnapshots(messId, targetDate);
  const existingSchedule = await getMergedSchedule(messId, targetDate);
  const requestedControls: RequestedControl[] = Array.isArray(mealControls)
    ? mealControls
    : targetDate === today
      ? MEAL_TYPES.flatMap((mealType) => {
          const enabledKey = `${mealType}Enabled` as keyof typeof existingSchedule;
          const incoming = mealType === "breakfast"
            ? breakfastEnabled
            : mealType === "lunch"
              ? lunchEnabled
              : dinnerEnabled;
          return typeof incoming === "boolean" && incoming !== existingSchedule[enabledKey]
            ? [{ mealType, enabled: incoming, scope: "ongoing" as const }]
            : [];
        })
      : [];

  for (const control of requestedControls) {
    if (
      !MEAL_TYPES.includes(control?.mealType)
      || !["day", "ongoing"].includes(control?.scope)
      || typeof control?.enabled !== "boolean"
    ) {
      res.status(400).json({ error: "Invalid meal control" });
      return;
    }
  }

  // Materialize tomorrow before a today-only change, so tomorrow retains the
  // state that existed before today's temporary override.
  if (targetDate === today && requestedControls.some((control) => control.scope === "day")) {
    await ensureMealControlSnapshots(messId, addDays(today, 1));
  }

  const values = {
    messId,
    date: targetDate,
    breakfastEnabled: breakfastEnabled ?? existingSchedule.breakfastEnabled,
    lunchEnabled: lunchEnabled ?? existingSchedule.lunchEnabled,
    dinnerEnabled: dinnerEnabled ?? existingSchedule.dinnerEnabled,
    breakfastOptOutStart: (breakfastOptOutStart as string | null) ?? null,
    breakfastOptOutEnd: (breakfastOptOutEnd as string | null) ?? null,
    lunchOptOutStart: (lunchOptOutStart as string | null) ?? null,
    lunchOptOutEnd: (lunchOptOutEnd as string | null) ?? null,
    dinnerOptOutStart: (dinnerOptOutStart as string | null) ?? null,
    dinnerOptOutEnd: (dinnerOptOutEnd as string | null) ?? null,
    breakfastMenu: (breakfastMenu as string | null) ?? null,
    lunchMenu: (lunchMenu as string | null) ?? null,
    dinnerMenu: (dinnerMenu as string | null) ?? null,
  };

  await db
    .insert(mealControlTable)
    .values(values)
    .onConflictDoUpdate({
      target: [mealControlTable.messId, mealControlTable.date],
      set: {
        breakfastEnabled: values.breakfastEnabled,
        lunchEnabled: values.lunchEnabled,
        dinnerEnabled: values.dinnerEnabled,
        breakfastOptOutStart: values.breakfastOptOutStart,
        breakfastOptOutEnd: values.breakfastOptOutEnd,
        lunchOptOutStart: values.lunchOptOutStart,
        lunchOptOutEnd: values.lunchOptOutEnd,
        dinnerOptOutStart: values.dinnerOptOutStart,
        dinnerOptOutEnd: values.dinnerOptOutEnd,
        breakfastMenu: values.breakfastMenu,
        lunchMenu: values.lunchMenu,
        dinnerMenu: values.dinnerMenu,
      },
    });

  // Changes made today update the baseline fields in snapshots that may
  // already exist. Future-date edits remain isolated to the selected row.
  if (targetDate === today) {
    const futureSet: Partial<{
      breakfastEnabled: boolean;
      lunchEnabled: boolean;
      dinnerEnabled: boolean;
      breakfastOptOutStart: string | null;
      breakfastOptOutEnd: string | null;
      lunchOptOutStart: string | null;
      lunchOptOutEnd: string | null;
      dinnerOptOutStart: string | null;
      dinnerOptOutEnd: string | null;
    }> = {};
    for (const control of requestedControls.filter((item) => item.scope === "ongoing")) {
      if (control.mealType === "breakfast") futureSet.breakfastEnabled = control.enabled;
      else if (control.mealType === "lunch") futureSet.lunchEnabled = control.enabled;
      else futureSet.dinnerEnabled = control.enabled;
    }

    if (
      values.breakfastOptOutStart !== existingSchedule.breakfastOptOutStart
      || values.breakfastOptOutEnd !== existingSchedule.breakfastOptOutEnd
    ) {
      futureSet.breakfastOptOutStart = values.breakfastOptOutStart;
      futureSet.breakfastOptOutEnd = values.breakfastOptOutEnd;
    }
    if (
      values.lunchOptOutStart !== existingSchedule.lunchOptOutStart
      || values.lunchOptOutEnd !== existingSchedule.lunchOptOutEnd
    ) {
      futureSet.lunchOptOutStart = values.lunchOptOutStart;
      futureSet.lunchOptOutEnd = values.lunchOptOutEnd;
    }
    if (
      values.dinnerOptOutStart !== existingSchedule.dinnerOptOutStart
      || values.dinnerOptOutEnd !== existingSchedule.dinnerOptOutEnd
    ) {
      futureSet.dinnerOptOutStart = values.dinnerOptOutStart;
      futureSet.dinnerOptOutEnd = values.dinnerOptOutEnd;
    }
    if (Object.keys(futureSet).length > 0) {
      await db
        .update(mealControlTable)
        .set(futureSet)
        .where(and(eq(mealControlTable.messId, messId), gt(mealControlTable.date, targetDate)));
    }
  }

  res.json({ success: true });
});

// POST /api/mess/meal-opt-out — consumer toggles one meal
router.post("/mess/meal-opt-out", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, date, mealType } = req.body ?? {};
  const messId = parseInt(messIdRaw, 10);

  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!MEAL_TYPES.includes(mealType as MealType)) {
    res.status(400).json({ error: "mealType must be breakfast, lunch, or dinner" });
    return;
  }

  const { mess, role, consumerId } = await getMessContext(userId, messId);
  if (!mess || !consumerId) {
    res.status(403).json({ error: "Consumer record not found for this mess" });
    return;
  }

  const targetDate = (date as string) ?? todayDate();
  const today = todayDate();
  if (isBeyondFutureLimit(targetDate)) {
    res.status(400).json({ error: `Meal on/off is only available up to ${MAX_FUTURE_DAYS} days ahead` });
    return;
  }
  await ensureMealControlSnapshots(messId, targetDate);
  const schedule = await getMergedSchedule(messId, targetDate);
  const enabledKey = `${mealType}Enabled` as keyof typeof schedule;
  if (!schedule[enabledKey]) {
    res.status(403).json({ error: `${mealType} is currently disabled by the admin` });
    return;
  }
  if (targetDate < today && role !== "admin") {
    res.status(403).json({ error: "Cannot change meal on/off for a past date" });
    return;
  }
  if (targetDate === today && role !== "admin") {
    const start = schedule[`${mealType}OptOutStart` as keyof typeof schedule] as string | null;
    const end = schedule[`${mealType}OptOutEnd` as keyof typeof schedule] as string | null;
    if (start && end && !isWithinWindow(start, end)) {
      res.status(403).json({ error: `Meal on/off window for ${mealType} has closed (${start}–${end})` });
      return;
    }
  }

  const [existing] = await db
    .select({ id: mealOptOutsTable.id })
    .from(mealOptOutsTable)
    .where(
      and(
        eq(mealOptOutsTable.messId, messId),
        eq(mealOptOutsTable.consumerId, consumerId),
        eq(mealOptOutsTable.date, targetDate),
        eq(mealOptOutsTable.mealType, mealType as string),
      ),
    )
    .limit(1);

  if (existing) {
    await db.delete(mealOptOutsTable).where(eq(mealOptOutsTable.id, existing.id));
    res.json({ isOptedOut: false });
  } else {
    await db.insert(mealOptOutsTable).values({
      messId,
      consumerId,
      date: targetDate,
      mealType: mealType as string,
    });
    res.json({ isOptedOut: true });
  }
});

// GET /api/mess/meal-opt-outs?messId=X&date=YYYY-MM-DD
router.get("/mess/meal-opt-outs", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = parseInt(req.query.messId as string, 10);
  const date = (req.query.date as string) ?? todayDate();

  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (isBeyondFutureLimit(date)) {
    res.status(400).json({ error: `Meal data is only available up to ${MAX_FUTURE_DAYS} days ahead` });
    return;
  }

  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  await ensureMealControlSnapshots(messId, date);

  const [optOutRows, consumerRows] = await Promise.all([
    db
      .select()
      .from(mealOptOutsTable)
      .where(and(eq(mealOptOutsTable.messId, messId), eq(mealOptOutsTable.date, date))),
    db
      .select({ id: consumersTable.id, name: consumersTable.name })
      .from(consumersTable)
      .where(eq(consumersTable.messId, messId)),
  ]);

  const optOutSet = new Set(optOutRows.map((item) => `${item.consumerId}:${item.mealType}`));
  const consumers = consumerRows.map((consumer) => ({
    consumerId: consumer.id,
    consumerName: consumer.name,
    breakfast: optOutSet.has(`${consumer.id}:breakfast`),
    lunch: optOutSet.has(`${consumer.id}:lunch`),
    dinner: optOutSet.has(`${consumer.id}:dinner`),
  }));

  res.json({ date, consumers });
});

export default router;
