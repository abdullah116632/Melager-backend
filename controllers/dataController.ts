import type { Response } from "express";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import {
  db,
  consumersTable,
  usersTable,
  mealsTable,
  expenseDaysTable,
  depositsTable,
  depositEntriesTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { sendMonthlySummaryEmail } from "../lib/email.js";
import {
  calculateAccountingSummary,
  countSettledResults,
  formatBlendedMonthLabel,
  getConsumerFinancialSummary,
} from "../utils/accountingUtils.js";
import {
  dateInAppTimeZone,
  getBufferedMonthBounds,
} from "../utils/dateUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { emitToMess } from "../realtime/socket.js";

const parseDecimal = (
  value: unknown,
  { allowNegative = false, allowZero = true } = {},
): number | null => {
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0)) return null;
  if (!allowZero && parsed === 0) return null;
  return parsed;
};

// GET /api/mess/data/:yearMonth?messId=X
export const getMonthData = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const yearMonth = req.params.yearMonth as string;
  const access = await resolveMessAccess(userId, req.query.messId, {
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

  // Read a one-day UTC buffer on each side, then keep rows whose local date
  // belongs to the requested month. This prevents midnight deposits from
  // moving into an adjacent month when the server itself runs in UTC.
  const { startDate, endDate } = getBufferedMonthBounds(yearMonth);

  const [consumers, mealRows, expenseRows, depositEntryRows] =
    await Promise.all([
      db
        .select({
          id: consumersTable.id,
          name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
          userId: consumersTable.userId,
          email: usersTable.email,
          mobileNumber: usersTable.mobileNumber,
          isAdmin: consumersTable.isAdmin,
          accountDeletedAt: consumersTable.accountDeletedAt,
        })
        .from(consumersTable)
        .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
        .where(eq(consumersTable.messId, mess.id)),
      db
        .select()
        .from(mealsTable)
        .where(
          and(
            eq(mealsTable.messId, mess.id),
            eq(mealsTable.yearMonth, yearMonth),
          ),
        ),
      db
        .select()
        .from(expenseDaysTable)
        .where(
          and(
            eq(expenseDaysTable.messId, mess.id),
            eq(expenseDaysTable.yearMonth, yearMonth),
          ),
        ),
      db
        .select()
        .from(depositEntriesTable)
        .where(
          and(
            eq(depositEntriesTable.messId, mess.id),
            gte(depositEntriesTable.depositedAt, startDate),
            lt(depositEntriesTable.depositedAt, endDate),
          ),
        ),
    ]);

  const meals: Record<string, Record<string, number>> = {};
  for (const row of mealRows) {
    const cid = row.consumerId.toString();
    if (!meals[cid]) meals[cid] = {};
    meals[cid][row.day.toString()] = row.count;
  }

  const expenses: Record<
    string,
    { items: Array<{ id: string; name: string; amount: number }> }
  > = {};
  for (const row of expenseRows) {
    expenses[row.day.toString()] = {
      items:
        (row.items as Array<{ id: string; name: string; amount: number }>) ??
        [],
    };
  }

  const deposits: Record<string, Record<string, number>> = {};
  for (const row of depositEntryRows) {
    const localDate = dateInAppTimeZone(row.depositedAt);
    if (!localDate.startsWith(`${yearMonth}-`)) continue;
    const cid = row.consumerId.toString();
    const day = Number(localDate.slice(8, 10)).toString();
    if (!deposits[cid]) deposits[cid] = {};
    deposits[cid][day] = (deposits[cid][day] ?? 0) + row.amount;
  }

  res.json({ consumers, meals, expenses, deposits });
};

// PUT /api/mess/meals  — body: { messId, consumerId, yearMonth, day, count }
export const setMeal = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const {
    messId: messIdRaw,
    consumerId,
    yearMonth,
    day,
    count,
  } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!consumerId || !yearMonth || day === undefined || count === undefined) {
    res
      .status(400)
      .json({ error: "consumerId, yearMonth, day, count are required" });
    return;
  }
  const mealCount = parseDecimal(count);
  if (mealCount === null) {
    res.status(400).json({
      error: "count must be a non-negative number with up to 3 decimal places",
    });
    return;
  }
  await db
    .insert(mealsTable)
    .values({
      messId: mess.id,
      consumerId: parseInt(consumerId, 10),
      yearMonth,
      day: parseInt(day, 10),
      count: mealCount,
    })
    .onConflictDoUpdate({
      target: [
        mealsTable.messId,
        mealsTable.consumerId,
        mealsTable.yearMonth,
        mealsTable.day,
      ],
      set: { count: mealCount },
    });
  emitToMess(mess.id, "meals:updated", {
    messId: mess.id,
    yearMonth,
  });
  res.json({ success: true });
};

// PUT /api/mess/expenses  — body: { messId, yearMonth, day, items }
export const setExpense = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonth, day, items } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!yearMonth || day === undefined || !Array.isArray(items)) {
    res.status(400).json({ error: "yearMonth, day, items[] are required" });
    return;
  }
  const normalizedItems = items.map((item) => {
    const amount = parseDecimal(item?.amount);
    return {
      id: String(item?.id ?? ""),
      name: String(item?.name ?? "").trim(),
      amount,
    };
  });
  if (
    normalizedItems.some(
      (item) => !item.id || !item.name || item.amount === null,
    )
  ) {
    res.status(400).json({
      error:
        "Each expense needs a name and a non-negative amount with up to 3 decimal places",
    });
    return;
  }
  await db
    .insert(expenseDaysTable)
    .values({
      messId: mess.id,
      yearMonth,
      day: parseInt(day, 10),
      items: normalizedItems as Array<{
        id: string;
        name: string;
        amount: number;
      }>,
    })
    .onConflictDoUpdate({
      target: [
        expenseDaysTable.messId,
        expenseDaysTable.yearMonth,
        expenseDaysTable.day,
      ],
      set: {
        items: normalizedItems as Array<{
          id: string;
          name: string;
          amount: number;
        }>,
      },
    });
  emitToMess(mess.id, "expenses:updated", {
    messId: mess.id,
    yearMonth,
  });
  res.json({ success: true });
};

// PUT /api/mess/deposits  — body: { messId, consumerId, yearMonth, day, amount }
export const setDeposit = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const {
    messId: messIdRaw,
    consumerId,
    yearMonth,
    day,
    amount,
  } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!consumerId || !yearMonth || day === undefined || amount === undefined) {
    res
      .status(400)
      .json({ error: "consumerId, yearMonth, day, amount are required" });
    return;
  }
  const depositAmount = parseDecimal(amount, {
    allowNegative: true,
  });
  if (depositAmount === null) {
    res.status(400).json({
      error: "amount must be a number with up to 3 decimal places",
    });
    return;
  }
  await db
    .insert(depositsTable)
    .values({
      messId: mess.id,
      consumerId: parseInt(consumerId, 10),
      yearMonth,
      day: parseInt(day, 10),
      amount: depositAmount,
    })
    .onConflictDoUpdate({
      target: [
        depositsTable.messId,
        depositsTable.consumerId,
        depositsTable.yearMonth,
        depositsTable.day,
      ],
      set: { amount: depositAmount },
    });
  emitToMess(mess.id, "deposits:updated", {
    messId: mess.id,
    yearMonth,
  });
  res.json({ success: true });
};

// POST /api/mess/send-summary — admin sends monthly summary emails to all consumers
export const sendSummary = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonth } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth as string)) {
    res.status(400).json({ error: "yearMonth is required (format: YYYY-MM)" });
    return;
  }

  const [consumers, mealRows, expenseRows, depositRows] = await Promise.all([
    db
      .select({
        id: consumersTable.id,
        name: consumersTable.name,
        email: usersTable.email,
      })
      .from(consumersTable)
      .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
      .where(eq(consumersTable.messId, mess.id)),
    db
      .select()
      .from(mealsTable)
      .where(
        and(
          eq(mealsTable.messId, mess.id),
          eq(mealsTable.yearMonth, yearMonth as string),
        ),
      ),
    db
      .select()
      .from(expenseDaysTable)
      .where(
        and(
          eq(expenseDaysTable.messId, mess.id),
          eq(expenseDaysTable.yearMonth, yearMonth as string),
        ),
      ),
    db
      .select()
      .from(depositsTable)
      .where(
        and(
          eq(depositsTable.messId, mess.id),
          eq(depositsTable.yearMonth, yearMonth as string),
        ),
      ),
  ]);

  const accounting = calculateAccountingSummary(
    mealRows,
    expenseRows,
    depositRows,
  );

  const withEmail = consumers.filter((c) => c.email);
  const results = await Promise.allSettled(
    withEmail.map((c) => {
      const summary = getConsumerFinancialSummary(c.id, accounting);
      return sendMonthlySummaryEmail(
        c.email!,
        c.name,
        mess.name,
        yearMonth as string,
        summary,
      );
    }),
  );

  const { sent, failed } = countSettledResults(results);
  if (failed > 0) {
    req.log.error({ failed }, "Some summary emails failed to send");
  }

  res.json({ sent, total: withEmail.length });
};

// POST /api/mess/send-blended-summary — admin sends blended multi-month summary to all consumers
export const sendBlendedSummary = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonths } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!Array.isArray(yearMonths) || yearMonths.length === 0) {
    res.status(400).json({ error: "yearMonths[] is required" });
    return;
  }

  const consumers = await db
    .select({
      id: consumersTable.id,
      name: consumersTable.name,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, mess.id));

  const allMealRows: Array<{ consumerId: number; count: number }> = [];
  const allExpenseRows: Array<{ items: unknown }> = [];
  const allDepositRows: Array<{ consumerId: number; amount: number }> = [];

  for (const ym of yearMonths as string[]) {
    const [mealRows, expenseRows, depositRows] = await Promise.all([
      db
        .select()
        .from(mealsTable)
        .where(
          and(eq(mealsTable.messId, mess.id), eq(mealsTable.yearMonth, ym)),
        ),
      db
        .select()
        .from(expenseDaysTable)
        .where(
          and(
            eq(expenseDaysTable.messId, mess.id),
            eq(expenseDaysTable.yearMonth, ym),
          ),
        ),
      db
        .select()
        .from(depositsTable)
        .where(
          and(
            eq(depositsTable.messId, mess.id),
            eq(depositsTable.yearMonth, ym),
          ),
        ),
    ]);

    allMealRows.push(...mealRows);
    allExpenseRows.push(...expenseRows);
    allDepositRows.push(...depositRows);
  }

  const accounting = calculateAccountingSummary(
    allMealRows,
    allExpenseRows,
    allDepositRows,
  );
  const blendLabel = formatBlendedMonthLabel(yearMonths as string[]);

  const withEmail = consumers.filter((c) => c.email);
  const results = await Promise.allSettled(
    withEmail.map((c) => {
      const summary = getConsumerFinancialSummary(c.id, accounting);
      return sendMonthlySummaryEmail(
        c.email!,
        c.name,
        mess.name,
        blendLabel,
        summary,
      );
    }),
  );

  const { sent, failed } = countSettledResults(results);
  if (failed > 0)
    req.log.error({ failed }, "Some blended summary emails failed to send");

  res.json({ sent, total: withEmail.length });
};
