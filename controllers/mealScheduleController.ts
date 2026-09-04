import type { Response } from "express";
import { and, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  consumersTable,
  mealControlTable,
  mealOptOutsTable,
  notificationsTable,
  usersTable,
} from "../db/dbConfig.js";
import { deliverNotifications } from "../lib/notificationDelivery.js";
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
import { emitToMess } from "../realtime/socket.js";

type MealOptOutScope = "day" | "ongoing";

const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const normalizeMenu = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const menu = value.trim();
  return menu || null;
};

const menuUpdates = (
  existing: {
    breakfastMenu: string | null;
    lunchMenu: string | null;
    dinnerMenu: string | null;
  },
  next: {
    breakfastMenu: string | null;
    lunchMenu: string | null;
    dinnerMenu: string | null;
  },
) =>
  (
    [
      ["Breakfast", existing.breakfastMenu, next.breakfastMenu],
      ["Lunch", existing.lunchMenu, next.lunchMenu],
      ["Dinner", existing.dinnerMenu, next.dinnerMenu],
    ] as const
  ).flatMap(([mealLabel, previous, menu]) =>
    menu && menu !== previous ? [{ mealLabel, isNew: !previous, menu }] : [],
  );

const isValidIsoDate = (date: string): boolean => {
  if (!ISO_DATE_PATTERN.test(date)) return false;
  const value = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date
  );
};

const getMonthEnd = (yearMonth: string): string => {
  const [year, month] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
};

const getEffectiveMealOptOuts = (messId: number, date: string) =>
  db
    .select()
    .from(mealOptOutsTable)
    .where(
      and(
        eq(mealOptOutsTable.messId, messId),
        or(
          and(
            eq(mealOptOutsTable.scope, "day"),
            eq(mealOptOutsTable.date, date),
          ),
          and(
            eq(mealOptOutsTable.scope, "ongoing"),
            lte(mealOptOutsTable.date, date),
            or(
              isNull(mealOptOutsTable.endedDate),
              gt(mealOptOutsTable.endedDate, date),
            ),
          ),
        ),
      ),
    );

const getSchedulePayload = async (
  messId: number,
  consumerId: number | null,
  date: string,
) => {
  const [schedule, allConsumers, optOutRows] = await Promise.all([
    getMergedSchedule(messId, date),
    db
      .select({ id: consumersTable.id })
      .from(consumersTable)
      .where(eq(consumersTable.messId, messId)),
    getEffectiveMealOptOuts(messId, date),
  ]);

  const totalConsumers = allConsumers.length;
  const effectiveOptOutKeys = new Set(
    optOutRows.map((item) => `${item.consumerId}:${item.mealType}`),
  );
  const myOptOuts = consumerId
    ? MEAL_TYPES.filter((mealType) =>
        effectiveOptOutKeys.has(`${consumerId}:${mealType}`),
      )
    : [];
  const optOutCountByMeal: Record<string, number> = {};
  for (const key of effectiveOptOutKeys) {
    const mealType = key.split(":")[1]!;
    optOutCountByMeal[mealType] = (optOutCountByMeal[mealType] ?? 0) + 1;
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

  return {
    date,
    schedule,
    myOptOuts,
    totalConsumers,
    activeByMeal,
    totalActive:
      activeByMeal.breakfast + activeByMeal.lunch + activeByMeal.dinner,
  };
};

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
  res.json(await getSchedulePayload(messId, consumerId, date));
};

// GET /api/v2/mess/meal-status/day?messId=X&date=YYYY-MM-DD
// Additive v2 endpoint: unlike the legacy "today-schedule" route, this is a
// read-only view over any date and never materializes rows for distant dates.
export const getMealStatusDayV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const date = String(req.query.date ?? getTodayDate());
  if (!isValidIsoDate(date)) {
    res.status(400).json({ error: "date must be a valid YYYY-MM-DD value" });
    return;
  }

  res.json(await getSchedulePayload(access.messId, access.consumerId, date));
};

// GET /api/v2/mess/meal-status/calendar?messId=X&yearMonth=YYYY-MM
// Returns only the signed-in consumer's marked days. Day rows mark one date;
// ongoing rows mark every date from their start until (but not including) end.
export const getMealStatusCalendarV2 = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const yearMonth = String(req.query.yearMonth ?? "");
  if (!YEAR_MONTH_PATTERN.test(yearMonth)) {
    res.status(400).json({ error: "yearMonth must use YYYY-MM format" });
    return;
  }

  const access = await resolveMessAccess(userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  if (!access.consumerId) {
    res.json({ yearMonth, days: [] });
    return;
  }

  const monthStart = `${yearMonth}-01`;
  const monthEnd = getMonthEnd(yearMonth);
  const rows = await db
    .select({
      date: mealOptOutsTable.date,
      mealType: mealOptOutsTable.mealType,
      scope: mealOptOutsTable.scope,
      endedDate: mealOptOutsTable.endedDate,
    })
    .from(mealOptOutsTable)
    .where(
      and(
        eq(mealOptOutsTable.messId, access.messId),
        eq(mealOptOutsTable.consumerId, access.consumerId),
        or(
          and(
            eq(mealOptOutsTable.scope, "day"),
            gte(mealOptOutsTable.date, monthStart),
            lte(mealOptOutsTable.date, monthEnd),
          ),
          and(
            eq(mealOptOutsTable.scope, "ongoing"),
            lte(mealOptOutsTable.date, monthEnd),
            or(
              isNull(mealOptOutsTable.endedDate),
              gt(mealOptOutsTable.endedDate, monthStart),
            ),
          ),
        ),
      ),
    );

  const days: Array<{ date: string; meals: MealType[] }> = [];
  for (let date = monthStart; date <= monthEnd; date = addDays(date, 1)) {
    const meals = MEAL_TYPES.filter((mealType) =>
      rows.some(
        (row) =>
          row.mealType === mealType &&
          (row.scope === "day"
            ? row.date === date
            : row.date <= date && (!row.endedDate || row.endedDate > date)),
      ),
    );
    if (meals.length > 0) days.push({ date, meals });
  }

  res.json({ yearMonth, days });
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
    breakfastMenu: normalizeMenu(breakfastMenu),
    lunchMenu: normalizeMenu(lunchMenu),
    dinnerMenu: normalizeMenu(dinnerMenu),
  };
  const changedMenus = menuUpdates(existingSchedule, values);

  const notifications = await db.transaction(async (tx) => {
    await tx
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

    if (changedMenus.length === 0) return [];
    const recipients = await tx
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          isNull(consumersTable.accountDeletedAt),
        ),
      );
    const recipientUserIds = [
      ...new Set(
        recipients.flatMap((recipient) =>
          recipient.userId == null ? [] : [recipient.userId],
        ),
      ),
    ];
    if (recipientUserIds.length === 0) return [];

    return tx
      .insert(notificationsTable)
      .values(
        recipientUserIds.flatMap((recipientUserId) =>
          changedMenus.map((change) => ({
            messId,
            userId: recipientUserId,
            type: "menu",
            title: `${change.mealLabel} menu ${change.isNew ? "set" : "updated"}`,
            body: `Menu for ${targetDate}: ${change.menu}`,
          })),
        ),
      )
      .returning();
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

  void deliverNotifications(notifications);
  emitToMess(messId, "meal-schedule:updated", {
    messId,
    date: targetDate,
  });
  res.json({ success: true });
};

const handleToggleMealOptOut = async (
  req: AuthedRequest,
  res: Response,
  options: { unlimitedFuture: boolean },
) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, date, mealType, scope: scopeRaw } = req.body ?? {};
  const messId = parsePositiveInteger(messIdRaw);
  const scope: MealOptOutScope = scopeRaw === "ongoing" ? "ongoing" : "day";

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
  if (options.unlimitedFuture && !isValidIsoDate(targetDate)) {
    res.status(400).json({ error: "date must be a valid YYYY-MM-DD value" });
    return;
  }
  if (!options.unlimitedFuture && isBeyondFutureLimit(targetDate)) {
    res.status(400).json({
      error: `Meal on/off is only available up to ${MAX_FUTURE_DAYS} days ahead`,
    });
    return;
  }
  if (!options.unlimitedFuture) {
    await ensureMealControlSnapshots(messId, targetDate);
  }
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

  const effectiveRows = (
    await getEffectiveMealOptOuts(messId, targetDate)
  ).filter(
    (item) =>
      item.consumerId === consumerId && item.mealType === (mealType as string),
  );

  if (effectiveRows.length > 0) {
    const dayIds = effectiveRows
      .filter((item) => item.scope === "day")
      .map((item) => item.id);
    const ongoingIds = effectiveRows
      .filter((item) => item.scope === "ongoing")
      .map((item) => item.id);

    if (dayIds.length > 0) {
      await db
        .delete(mealOptOutsTable)
        .where(inArray(mealOptOutsTable.id, dayIds));
    }
    if (ongoingIds.length > 0) {
      await db
        .update(mealOptOutsTable)
        .set({ endedDate: targetDate })
        .where(inArray(mealOptOutsTable.id, ongoingIds));
    }
    await notifyManagersOfMealStatusChange({
      messId,
      actorUserId: userId,
      actorConsumerId: consumerId,
      mealType: mealType as MealType,
      isOptedOut: false,
      date: targetDate,
    });
    res.json({ isOptedOut: false, scope: null });
  } else {
    await db
      .insert(mealOptOutsTable)
      .values({
        messId,
        consumerId,
        date: targetDate,
        mealType: mealType as string,
        scope,
        endedDate: null,
      })
      .onConflictDoUpdate({
        target: [
          mealOptOutsTable.messId,
          mealOptOutsTable.consumerId,
          mealOptOutsTable.date,
          mealOptOutsTable.mealType,
        ],
        set: { scope, endedDate: null },
      });
    await notifyManagersOfMealStatusChange({
      messId,
      actorUserId: userId,
      actorConsumerId: consumerId,
      mealType: mealType as MealType,
      isOptedOut: true,
      date: targetDate,
    });
    res.json({ isOptedOut: true, scope });
  }
};

const notifyManagersOfMealStatusChange = async ({
  messId,
  actorUserId,
  actorConsumerId,
  mealType,
  isOptedOut,
  date,
}: {
  messId: number;
  actorUserId: number;
  actorConsumerId: number;
  mealType: MealType;
  isOptedOut: boolean;
  date: string;
}) => {
  const [actor, managers] = await Promise.all([
    db
      .select({
        name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      })
      .from(consumersTable)
      .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
      .where(
        and(
          eq(consumersTable.id, actorConsumerId),
          eq(consumersTable.messId, messId),
        ),
      )
      .limit(1),
    db
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.isAdmin, true),
          isNull(consumersTable.accountDeletedAt),
          sql`${consumersTable.userId} is not null`,
        ),
      ),
  ]);
  const managerUserIds = [
    ...new Set(
      managers.flatMap(({ userId }) =>
        userId == null || userId === actorUserId ? [] : [userId],
      ),
    ),
  ];
  if (managerUserIds.length === 0) return;

  const mealLabel = mealType.charAt(0).toUpperCase() + mealType.slice(1);
  const action = isOptedOut ? "turned off" : "turned on";
  const notifications = await db
    .insert(notificationsTable)
    .values(
      managerUserIds.map((userId) => ({
        messId,
        userId,
        type: "meal_opt_out",
        title: `${mealLabel} ${action}`,
        body: `${actor[0]?.name ?? "A member"} ${action} ${mealType} for ${date}.`,
      })),
    )
    .returning();
  void deliverNotifications(notifications);
};

// POST /api/mess/meal-opt-out — legacy endpoint kept unchanged for old apps.
export const toggleMealOptOut = (req: AuthedRequest, res: Response) =>
  handleToggleMealOptOut(req, res, { unlimitedFuture: false });

// POST /api/v2/mess/meal-status/opt-out — supports any future date without
// creating a meal-control snapshot for every date between today and the target.
export const toggleMealOptOutV2 = (req: AuthedRequest, res: Response) =>
  handleToggleMealOptOut(req, res, { unlimitedFuture: true });

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
    getEffectiveMealOptOuts(messId, date),
    db
      .select({
        id: consumersTable.id,
        name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      })
      .from(consumersTable)
      .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
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
