import type { Response } from "express";
import { and, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  consumersTable,
  mealControlHelperTable,
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
  getV2MergedSchedule,
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
  scheduleReader: typeof getMergedSchedule = getMergedSchedule,
  includeConsumers = false,
) => {
  const [schedule, allConsumers, optOutRows] = await Promise.all([
    scheduleReader(messId, date),
    db
      .select({
        id: consumersTable.id,
        name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      })
      .from(consumersTable)
      .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
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

  const payload = {
    date,
    schedule,
    myOptOuts,
    totalConsumers,
    activeByMeal,
    totalActive:
      activeByMeal.breakfast + activeByMeal.lunch + activeByMeal.dinner,
  };
  if (includeConsumers) {
    return {
      ...payload,
      consumers: allConsumers.map((consumer) => ({
        consumerId: consumer.id,
        consumerName: consumer.name,
        breakfast: effectiveOptOutKeys.has(`${consumer.id}:breakfast`),
        lunch: effectiveOptOutKeys.has(`${consumer.id}:lunch`),
        dinner: effectiveOptOutKeys.has(`${consumer.id}:dinner`),
      })),
    };
  }
  return payload;
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

  res.json(
    await getSchedulePayload(
      access.messId,
      access.consumerId,
      date,
      getV2MergedSchedule,
      access.role === "admin",
    ),
  );
};

const hasBodyField = (body: Record<string, unknown>, field: string) =>
  Object.prototype.hasOwnProperty.call(body, field);

const normalizeWindow = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const window = value.trim();
  return window || null;
};

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const validateMealWindow = (
  mealLabel: string,
  start: string | null,
  end: string | null,
): string | null => {
  if (start === null && end === null) return null;
  if (!start || !end)
    return `${mealLabel} on/off window requires both a start and end time`;
  if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end))
    return `${mealLabel} on/off window must use HH:MM (24-hour) format`;
  if (start > end)
    return `${mealLabel} on/off window end time must be after its start time`;
  return null;
};

// PUT /api/v2/mess/meal-schedule — helper-backed schedule updates
export const setMealScheduleV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const messIdRaw = body.messId;
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const targetDate = String(body.date ?? getTodayDate());
  const today = getTodayDate();
  if (!isValidIsoDate(targetDate)) {
    res.status(400).json({ error: "date must be a valid YYYY-MM-DD value" });
    return;
  }
  if (targetDate < today) {
    res.status(403).json({ error: "Past meal schedules are read-only" });
    return;
  }
  const existingSchedule = await getV2MergedSchedule(access.messId, targetDate);
  const nextSchedule = {
    breakfastEnabled:
      typeof body.breakfastEnabled === "boolean"
        ? body.breakfastEnabled
        : existingSchedule.breakfastEnabled,
    breakfastOptOutStart: hasBodyField(body, "breakfastOptOutStart")
      ? normalizeWindow(body.breakfastOptOutStart)
      : existingSchedule.breakfastOptOutStart,
    breakfastOptOutEnd: hasBodyField(body, "breakfastOptOutEnd")
      ? normalizeWindow(body.breakfastOptOutEnd)
      : existingSchedule.breakfastOptOutEnd,
    lunchEnabled:
      typeof body.lunchEnabled === "boolean"
        ? body.lunchEnabled
        : existingSchedule.lunchEnabled,
    lunchOptOutStart: hasBodyField(body, "lunchOptOutStart")
      ? normalizeWindow(body.lunchOptOutStart)
      : existingSchedule.lunchOptOutStart,
    lunchOptOutEnd: hasBodyField(body, "lunchOptOutEnd")
      ? normalizeWindow(body.lunchOptOutEnd)
      : existingSchedule.lunchOptOutEnd,
    dinnerEnabled:
      typeof body.dinnerEnabled === "boolean"
        ? body.dinnerEnabled
        : existingSchedule.dinnerEnabled,
    dinnerOptOutStart: hasBodyField(body, "dinnerOptOutStart")
      ? normalizeWindow(body.dinnerOptOutStart)
      : existingSchedule.dinnerOptOutStart,
    dinnerOptOutEnd: hasBodyField(body, "dinnerOptOutEnd")
      ? normalizeWindow(body.dinnerOptOutEnd)
      : existingSchedule.dinnerOptOutEnd,
    breakfastMenu: hasBodyField(body, "breakfastMenu")
      ? normalizeMenu(body.breakfastMenu)
      : existingSchedule.breakfastMenu,
    lunchMenu: hasBodyField(body, "lunchMenu")
      ? normalizeMenu(body.lunchMenu)
      : existingSchedule.lunchMenu,
    dinnerMenu: hasBodyField(body, "dinnerMenu")
      ? normalizeMenu(body.dinnerMenu)
      : existingSchedule.dinnerMenu,
  };

  const availabilityAndWindowFields = [
    "breakfastEnabled",
    "breakfastOptOutStart",
    "breakfastOptOutEnd",
    "lunchEnabled",
    "lunchOptOutStart",
    "lunchOptOutEnd",
    "dinnerEnabled",
    "dinnerOptOutStart",
    "dinnerOptOutEnd",
  ];
  const menuFields = ["breakfastMenu", "lunchMenu", "dinnerMenu"];
  const hasAvailabilityOrWindowInput = availabilityAndWindowFields.some(
    (field) => hasBodyField(body, field),
  );
  const hasMenuInput = menuFields.some((field) => hasBodyField(body, field));
  const hasScheduleInput = hasAvailabilityOrWindowInput || hasMenuInput;

  for (const [mealLabel, startField, endField, start, end] of [
    [
      "Breakfast",
      "breakfastOptOutStart",
      "breakfastOptOutEnd",
      nextSchedule.breakfastOptOutStart,
      nextSchedule.breakfastOptOutEnd,
    ],
    [
      "Lunch",
      "lunchOptOutStart",
      "lunchOptOutEnd",
      nextSchedule.lunchOptOutStart,
      nextSchedule.lunchOptOutEnd,
    ],
    [
      "Dinner",
      "dinnerOptOutStart",
      "dinnerOptOutEnd",
      nextSchedule.dinnerOptOutStart,
      nextSchedule.dinnerOptOutEnd,
    ],
  ] as const) {
    if (!hasBodyField(body, startField) && !hasBodyField(body, endField))
      continue;
    const error = validateMealWindow(mealLabel, start, end);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }

  const existingControl = await db
    .select({
      id: mealControlTable.id,
      breakfastEnabledOverride: mealControlTable.breakfastEnabledOverride,
      breakfastWindowOverride: mealControlTable.breakfastWindowOverride,
      lunchEnabledOverride: mealControlTable.lunchEnabledOverride,
      lunchWindowOverride: mealControlTable.lunchWindowOverride,
      dinnerEnabledOverride: mealControlTable.dinnerEnabledOverride,
      dinnerWindowOverride: mealControlTable.dinnerWindowOverride,
    })
    .from(mealControlTable)
    .where(
      and(
        eq(mealControlTable.messId, access.messId),
        eq(mealControlTable.date, targetDate),
      ),
    )
    .limit(1);
  const hasExistingDateRow = existingControl.length > 0;
  const existingDateControl = existingControl[0];
  const touchedByAspect = {
    breakfastEnabled: hasBodyField(body, "breakfastEnabled"),
    breakfastWindow:
      hasBodyField(body, "breakfastOptOutStart") ||
      hasBodyField(body, "breakfastOptOutEnd"),
    lunchEnabled: hasBodyField(body, "lunchEnabled"),
    lunchWindow:
      hasBodyField(body, "lunchOptOutStart") ||
      hasBodyField(body, "lunchOptOutEnd"),
    dinnerEnabled: hasBodyField(body, "dinnerEnabled"),
    dinnerWindow:
      hasBodyField(body, "dinnerOptOutStart") ||
      hasBodyField(body, "dinnerOptOutEnd"),
  };
  const isToday = targetDate === today;
  // Editing today always rewrites the ongoing baseline, so a touched aspect
  // clears any day-only override it had; editing a future date always makes
  // the touched aspect a day-only override. An aspect the request didn't
  // touch keeps whatever override state the row already had.
  const overrideFor = (touched: boolean, existing: boolean | undefined) =>
    touched ? !isToday : (existing ?? false);
  const dateControlOverrides = {
    breakfastEnabledOverride: overrideFor(
      touchedByAspect.breakfastEnabled,
      existingDateControl?.breakfastEnabledOverride,
    ),
    breakfastWindowOverride: overrideFor(
      touchedByAspect.breakfastWindow,
      existingDateControl?.breakfastWindowOverride,
    ),
    lunchEnabledOverride: overrideFor(
      touchedByAspect.lunchEnabled,
      existingDateControl?.lunchEnabledOverride,
    ),
    lunchWindowOverride: overrideFor(
      touchedByAspect.lunchWindow,
      existingDateControl?.lunchWindowOverride,
    ),
    dinnerEnabledOverride: overrideFor(
      touchedByAspect.dinnerEnabled,
      existingDateControl?.dinnerEnabledOverride,
    ),
    dinnerWindowOverride: overrideFor(
      touchedByAspect.dinnerWindow,
      existingDateControl?.dinnerWindowOverride,
    ),
  };
  const changedMenus = menuUpdates(existingSchedule, nextSchedule);

  const notifications = await db.transaction(async (tx) => {
    const mergedControlValues = {
      breakfastEnabled: nextSchedule.breakfastEnabled,
      lunchEnabled: nextSchedule.lunchEnabled,
      dinnerEnabled: nextSchedule.dinnerEnabled,
      breakfastOptOutStart: nextSchedule.breakfastOptOutStart,
      breakfastOptOutEnd: nextSchedule.breakfastOptOutEnd,
      lunchOptOutStart: nextSchedule.lunchOptOutStart,
      lunchOptOutEnd: nextSchedule.lunchOptOutEnd,
      dinnerOptOutStart: nextSchedule.dinnerOptOutStart,
      dinnerOptOutEnd: nextSchedule.dinnerOptOutEnd,
    };

    const dateValues = {
      messId: access.messId,
      date: targetDate,
      ...mergedControlValues,
      ...dateControlOverrides,
      breakfastMenu: nextSchedule.breakfastMenu,
      lunchMenu: nextSchedule.lunchMenu,
      dinnerMenu: nextSchedule.dinnerMenu,
    };
    const dateUpdateValues = {
      ...mergedControlValues,
      ...dateControlOverrides,
      breakfastMenu: nextSchedule.breakfastMenu,
      lunchMenu: nextSchedule.lunchMenu,
      dinnerMenu: nextSchedule.dinnerMenu,
    };

    if (isToday) {
      // Only the touched aspects become the new ongoing baseline — an
      // untouched meal must never inherit another meal's day-only override
      // value through this write.
      const helperPatch: Partial<typeof mergedControlValues> = {};
      if (touchedByAspect.breakfastEnabled)
        helperPatch.breakfastEnabled = nextSchedule.breakfastEnabled;
      if (touchedByAspect.breakfastWindow) {
        helperPatch.breakfastOptOutStart = nextSchedule.breakfastOptOutStart;
        helperPatch.breakfastOptOutEnd = nextSchedule.breakfastOptOutEnd;
      }
      if (touchedByAspect.lunchEnabled)
        helperPatch.lunchEnabled = nextSchedule.lunchEnabled;
      if (touchedByAspect.lunchWindow) {
        helperPatch.lunchOptOutStart = nextSchedule.lunchOptOutStart;
        helperPatch.lunchOptOutEnd = nextSchedule.lunchOptOutEnd;
      }
      if (touchedByAspect.dinnerEnabled)
        helperPatch.dinnerEnabled = nextSchedule.dinnerEnabled;
      if (touchedByAspect.dinnerWindow) {
        helperPatch.dinnerOptOutStart = nextSchedule.dinnerOptOutStart;
        helperPatch.dinnerOptOutEnd = nextSchedule.dinnerOptOutEnd;
      }
      if (Object.keys(helperPatch).length > 0) {
        await tx
          .insert(mealControlHelperTable)
          .values({ messId: access.messId, ...helperPatch })
          .onConflictDoUpdate({
            target: mealControlHelperTable.messId,
            set: helperPatch,
          });
      }
    }

    if (
      (isToday && (hasExistingDateRow || hasMenuInput)) ||
      (!isToday && hasScheduleInput)
    ) {
      // Menus always belong to a concrete date, including an explicit
      // clearing of a menu (which is why this checks the input field, not
      // whether the next menu value is non-empty).
      await tx
        .insert(mealControlTable)
        .values(dateValues)
        .onConflictDoUpdate({
          target: [mealControlTable.messId, mealControlTable.date],
          set: dateUpdateValues,
        });
    }

    if (changedMenus.length === 0) return [];
    const recipients = await tx
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, access.messId),
          isNull(consumersTable.accountDeletedAt),
        ),
      );
    const recipientUserIds = [
      ...new Set(
        recipients.flatMap((recipient) =>
          recipient.userId == null || recipient.userId === userId
            ? []
            : [recipient.userId],
        ),
      ),
    ];
    if (recipientUserIds.length === 0) return [];
    return tx
      .insert(notificationsTable)
      .values(
        recipientUserIds.flatMap((recipientUserId) =>
          changedMenus.map((change) => ({
            messId: access.messId,
            userId: recipientUserId,
            type: "menu",
            title: `${change.mealLabel} menu ${change.isNew ? "set" : "updated"}`,
            body: `Menu for ${targetDate}: ${change.menu}`,
          })),
        ),
      )
      .returning();
  });

  void deliverNotifications(notifications);
  emitToMess(access.messId, "meal-schedule:updated", {
    messId: access.messId,
    date: targetDate,
  });
  res.json({ success: true });
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
  options: {
    unlimitedFuture: boolean;
    allowAdminPastChanges: boolean;
    scheduleReader: typeof getMergedSchedule;
  },
) => {
  const userId = req.auth!.userId;
  const {
    messId: messIdRaw,
    date,
    mealType,
    scope: scopeRaw,
    isOptedOut: requestedOptOutState,
  } = req.body ?? {};
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
  if (
    requestedOptOutState !== undefined &&
    typeof requestedOptOutState !== "boolean"
  ) {
    res.status(400).json({ error: "isOptedOut must be a boolean" });
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

  const effectiveRows = (
    await getEffectiveMealOptOuts(messId, targetDate)
  ).filter(
    (item) =>
      item.consumerId === consumerId && item.mealType === (mealType as string),
  );
  const currentlyOptedOut = effectiveRows.length > 0;
  const shouldBeOptedOut =
    typeof requestedOptOutState === "boolean"
      ? requestedOptOutState
      : !currentlyOptedOut;

  // Resolve retries before time-window and availability validation. The first
  // request may have succeeded just before its response was lost.
  if (shouldBeOptedOut === currentlyOptedOut) {
    res.json({
      isOptedOut: currentlyOptedOut,
      scope: currentlyOptedOut
        ? (effectiveRows.find((item) => item.scope === "ongoing")?.scope ??
          effectiveRows[0]?.scope ??
          scope)
        : null,
    });
    return;
  }

  if (!options.unlimitedFuture) {
    await ensureMealControlSnapshots(messId, targetDate);
  }
  const schedule = await options.scheduleReader(messId, targetDate);
  const enabledKey = `${mealType}Enabled` as keyof typeof schedule;
  if (!schedule[enabledKey]) {
    res
      .status(403)
      .json({ error: `${mealType} is currently disabled by the admin` });
    return;
  }
  if (
    targetDate < today &&
    (role !== "admin" || !options.allowAdminPastChanges)
  ) {
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

  if (!shouldBeOptedOut) {
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
  handleToggleMealOptOut(req, res, {
    unlimitedFuture: false,
    allowAdminPastChanges: true,
    scheduleReader: getMergedSchedule,
  });

// POST /api/v2/mess/meal-status/opt-out — supports any future date without
// creating a meal-control snapshot for every date between today and the target.
export const toggleMealOptOutV2 = (req: AuthedRequest, res: Response) =>
  handleToggleMealOptOut(req, res, {
    unlimitedFuture: true,
    allowAdminPastChanges: false,
    scheduleReader: getV2MergedSchedule,
  });

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
