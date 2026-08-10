import type { Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import {
  db,
  consumersTable,
  mealControlTable,
  mealOptOutsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  addDays,
  ensureMealControlSnapshots,
  getMergedSchedule,
  getTodayDate,
  isBeyondFutureLimit,
  isWithinMealOptOutWindow,
  MAX_FUTURE_DAYS,
  MEAL_TYPES,
  type MealType,
  type RequestedControl,
} from "../utils/mealScheduleUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

// GET /api/mess/today-schedule?messId=X[&date=YYYY-MM-DD]
export const getTodaySchedule = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId, consumerId } = access;

  const date = (req.query.date as string) || getTodayDate();
  if (isBeyondFutureLimit(date)) {
    res
      .status(400)
      .json({ error: `Only the next ${MAX_FUTURE_DAYS} days are available` });
    return;
  }
  await ensureMealControlSnapshots(messId, date);

  const [schedule, allConsumers, optOutRows] = await Promise.all([
    getMergedSchedule(messId, date),
    db
      .select({ id: consumersTable.id })
      .from(consumersTable)
      .where(eq(consumersTable.messId, messId)),
    db
      .select()
      .from(mealOptOutsTable)
      .where(
        and(
          eq(mealOptOutsTable.messId, messId),
          eq(mealOptOutsTable.date, date),
        ),
      ),
  ]);

  const totalConsumers = allConsumers.length;
  const myOptOuts = consumerId
    ? optOutRows
        .filter((item) => item.consumerId === consumerId)
        .map((item) => item.mealType)
    : [];
  const optOutCountByMeal: Record<string, number> = {};
  for (const item of optOutRows) {
    optOutCountByMeal[item.mealType] =
      (optOutCountByMeal[item.mealType] ?? 0) + 1;
  }

  const activeByMeal = {
    breakfast: schedule.breakfastEnabled
      ? Math.max(0, totalConsumers - (optOutCountByMeal.breakfast ?? 0))
      : 0,
    lunch: schedule.lunchEnabled
      ? Math.max(0, totalConsumers - (optOutCountByMeal.lunch ?? 0))
      : 0,
    dinner: schedule.dinnerEnabled
      ? Math.max(0, totalConsumers - (optOutCountByMeal.dinner ?? 0))
      : 0,
  };

  res.json({
    date,
    schedule,
    myOptOuts,
    totalConsumers,
    activeByMeal,
    totalActive:
      activeByMeal.breakfast + activeByMeal.lunch + activeByMeal.dinner,
  });
};

// PUT /api/mess/meal-schedule — admin updates one daily control row
export const setMealSchedule = async (req: AuthedRequest, res: Response) => {
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

  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const targetDate = (date as string) ?? getTodayDate();
  const today = getTodayDate();
  if (targetDate < today) {
    res.status(403).json({ error: "Past meal schedules are read-only" });
    return;
  }
  if (isBeyondFutureLimit(targetDate)) {
    res.status(400).json({
      error: `Meal schedules can only be set up to ${MAX_FUTURE_DAYS} days ahead`,
    });
    return;
  }

  await ensureMealControlSnapshots(messId, targetDate);
  const existingSchedule = await getMergedSchedule(messId, targetDate);
  const requestedControls: RequestedControl[] = Array.isArray(mealControls)
    ? mealControls
    : targetDate === today
      ? MEAL_TYPES.flatMap((mealType) => {
          const enabledKey =
            `${mealType}Enabled` as keyof typeof existingSchedule;
          const incoming =
            mealType === "breakfast"
              ? breakfastEnabled
              : mealType === "lunch"
                ? lunchEnabled
                : dinnerEnabled;
          return typeof incoming === "boolean" &&
            incoming !== existingSchedule[enabledKey]
            ? [{ mealType, enabled: incoming, scope: "ongoing" as const }]
            : [];
        })
      : [];

  for (const control of requestedControls) {
    if (
      !MEAL_TYPES.includes(control?.mealType) ||
      !["day", "ongoing"].includes(control?.scope) ||
      typeof control?.enabled !== "boolean"
    ) {
      res.status(400).json({ error: "Invalid meal control" });
      return;
    }
  }

  // Materialize tomorrow before a today-only change, so tomorrow retains the
  // state that existed before today's temporary override.
  if (
    targetDate === today &&
    requestedControls.some((control) => control.scope === "day")
  ) {
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
    for (const control of requestedControls.filter(
      (item) => item.scope === "ongoing",
    )) {
      if (control.mealType === "breakfast")
        futureSet.breakfastEnabled = control.enabled;
      else if (control.mealType === "lunch")
        futureSet.lunchEnabled = control.enabled;
      else futureSet.dinnerEnabled = control.enabled;
    }

    if (
      values.breakfastOptOutStart !== existingSchedule.breakfastOptOutStart ||
      values.breakfastOptOutEnd !== existingSchedule.breakfastOptOutEnd
    ) {
      futureSet.breakfastOptOutStart = values.breakfastOptOutStart;
      futureSet.breakfastOptOutEnd = values.breakfastOptOutEnd;
    }
    if (
      values.lunchOptOutStart !== existingSchedule.lunchOptOutStart ||
      values.lunchOptOutEnd !== existingSchedule.lunchOptOutEnd
    ) {
      futureSet.lunchOptOutStart = values.lunchOptOutStart;
      futureSet.lunchOptOutEnd = values.lunchOptOutEnd;
    }
    if (
      values.dinnerOptOutStart !== existingSchedule.dinnerOptOutStart ||
      values.dinnerOptOutEnd !== existingSchedule.dinnerOptOutEnd
    ) {
      futureSet.dinnerOptOutStart = values.dinnerOptOutStart;
      futureSet.dinnerOptOutEnd = values.dinnerOptOutEnd;
    }
    if (Object.keys(futureSet).length > 0) {
      await db
        .update(mealControlTable)
        .set(futureSet)
        .where(
          and(
            eq(mealControlTable.messId, messId),
            gt(mealControlTable.date, targetDate),
          ),
        );
    }
  }

  res.json({ success: true });
};

// POST /api/mess/meal-opt-out — consumer toggles one meal
export const toggleMealOptOut = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, date, mealType } = req.body ?? {};
  const messId = parsePositiveInteger(messIdRaw);

  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!MEAL_TYPES.includes(mealType as MealType)) {
    res
      .status(400)
      .json({ error: "mealType must be breakfast, lunch, or dinner" });
    return;
  }

  const access = await resolveMessAccess(userId, messId);
  if (!access.ok || !access.consumerId) {
    res.status(403).json({ error: "Consumer record not found for this mess" });
    return;
  }
  const { role, consumerId } = access;

  const targetDate = (date as string) ?? getTodayDate();
  const today = getTodayDate();
  if (isBeyondFutureLimit(targetDate)) {
    res.status(400).json({
      error: `Meal on/off is only available up to ${MAX_FUTURE_DAYS} days ahead`,
    });
    return;
  }
  await ensureMealControlSnapshots(messId, targetDate);
  const schedule = await getMergedSchedule(messId, targetDate);
  const enabledKey = `${mealType}Enabled` as keyof typeof schedule;
  if (!schedule[enabledKey]) {
    res
      .status(403)
      .json({ error: `${mealType} is currently disabled by the admin` });
    return;
  }
  if (targetDate < today && role !== "admin") {
    res
      .status(403)
      .json({ error: "Cannot change meal on/off for a past date" });
    return;
  }
  if (targetDate === today && role !== "admin") {
    const start = schedule[
      `${mealType}OptOutStart` as keyof typeof schedule
    ] as string | null;
    const end = schedule[`${mealType}OptOutEnd` as keyof typeof schedule] as
      string | null;
    if (start && end && !isWithinMealOptOutWindow(start, end)) {
      res.status(403).json({
        error: `Meal on/off window for ${mealType} has closed (${start}–${end})`,
      });
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
    await db
      .delete(mealOptOutsTable)
      .where(eq(mealOptOutsTable.id, existing.id));
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
};

// GET /api/mess/meal-opt-outs?messId=X&date=YYYY-MM-DD
export const getMealOptOuts = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const messId = parsePositiveInteger(req.query.messId);
  const date = (req.query.date as string) ?? getTodayDate();

  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (isBeyondFutureLimit(date)) {
    res.status(400).json({
      error: `Meal data is only available up to ${MAX_FUTURE_DAYS} days ahead`,
    });
    return;
  }

  const access = await resolveMessAccess(userId, messId, { adminOnly: true });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  await ensureMealControlSnapshots(messId, date);

  const [optOutRows, consumerRows] = await Promise.all([
    db
      .select()
      .from(mealOptOutsTable)
      .where(
        and(
          eq(mealOptOutsTable.messId, messId),
          eq(mealOptOutsTable.date, date),
        ),
      ),
    db
      .select({ id: consumersTable.id, name: consumersTable.name })
      .from(consumersTable)
      .where(eq(consumersTable.messId, messId)),
  ]);

  const optOutSet = new Set(
    optOutRows.map((item) => `${item.consumerId}:${item.mealType}`),
  );
  const consumers = consumerRows.map((consumer) => ({
    consumerId: consumer.id,
    consumerName: consumer.name,
    breakfast: optOutSet.has(`${consumer.id}:breakfast`),
    lunch: optOutSet.has(`${consumer.id}:lunch`),
    dinner: optOutSet.has(`${consumer.id}:dinner`),
  }));

  res.json({ date, consumers });
};
