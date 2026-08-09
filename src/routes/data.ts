import { Router } from "express";
import { eq, and, gte, lt } from "drizzle-orm";
import {
  db,
  consumersTable,
  usersTable,
  mealsTable,
  expenseDaysTable,
  depositsTable,
  depositEntriesTable,
} from "../../db/index.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendMonthlySummaryEmail } from "../lib/email.js";
import { getMessContext } from "../lib/mess-access.js";

const router = Router();
const APP_TIME_ZONE = process.env.APP_TIME_ZONE ?? "Asia/Dhaka";

function dateInAppTimeZone(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// GET /api/mess/data/:yearMonth?messId=X
router.get("/mess/data/:yearMonth", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const yearMonth = req.params.yearMonth as string;
  const messId = parseInt(req.query.messId as string, 10);
  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }

  const { mess } = await getMessContext(userId, messId);
  if (!mess) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const [year, month] = yearMonth.split("-").map(Number);
  // Read a one-day UTC buffer on each side, then keep rows whose local date
  // belongs to the requested month. This prevents midnight deposits from
  // moving into an adjacent month when the server itself runs in UTC.
  const startDate = new Date(Date.UTC(year, month - 1, 1) - 24 * 60 * 60 * 1000);
  const endDate = new Date(Date.UTC(year, month, 1) + 24 * 60 * 60 * 1000);

  const [consumers, mealRows, expenseRows, depositEntryRows] = await Promise.all([
    db
      .select({ id: consumersTable.id, name: consumersTable.name })
      .from(consumersTable)
      .where(eq(consumersTable.messId, mess.id)),
    db
      .select()
      .from(mealsTable)
      .where(and(eq(mealsTable.messId, mess.id), eq(mealsTable.yearMonth, yearMonth))),
    db
      .select()
      .from(expenseDaysTable)
      .where(
        and(eq(expenseDaysTable.messId, mess.id), eq(expenseDaysTable.yearMonth, yearMonth)),
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
        (row.items as Array<{ id: string; name: string; amount: number }>) ?? [],
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
});

// PUT /api/mess/meals  — body: { messId, consumerId, yearMonth, day, count }
router.put("/mess/meals", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, consumerId, yearMonth, day, count } = req.body ?? {};
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
  if (!consumerId || !yearMonth || day === undefined || count === undefined) {
    res.status(400).json({ error: "consumerId, yearMonth, day, count are required" });
    return;
  }
  await db
    .insert(mealsTable)
    .values({
      messId: mess.id,
      consumerId: parseInt(consumerId, 10),
      yearMonth,
      day: parseInt(day, 10),
      count: parseInt(count, 10),
    })
    .onConflictDoUpdate({
      target: [mealsTable.messId, mealsTable.consumerId, mealsTable.yearMonth, mealsTable.day],
      set: { count: parseInt(count, 10) },
    });
  res.json({ success: true });
});

// PUT /api/mess/expenses  — body: { messId, yearMonth, day, items }
router.put("/mess/expenses", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonth, day, items } = req.body ?? {};
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
  if (!yearMonth || day === undefined || !Array.isArray(items)) {
    res.status(400).json({ error: "yearMonth, day, items[] are required" });
    return;
  }
  await db
    .insert(expenseDaysTable)
    .values({ messId: mess.id, yearMonth, day: parseInt(day, 10), items })
    .onConflictDoUpdate({
      target: [expenseDaysTable.messId, expenseDaysTable.yearMonth, expenseDaysTable.day],
      set: { items },
    });
  res.json({ success: true });
});

// PUT /api/mess/deposits  — body: { messId, consumerId, yearMonth, day, amount }
router.put("/mess/deposits", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, consumerId, yearMonth, day, amount } = req.body ?? {};
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
  if (!consumerId || !yearMonth || day === undefined || amount === undefined) {
    res.status(400).json({ error: "consumerId, yearMonth, day, amount are required" });
    return;
  }
  await db
    .insert(depositsTable)
    .values({
      messId: mess.id,
      consumerId: parseInt(consumerId, 10),
      yearMonth,
      day: parseInt(day, 10),
      amount: parseInt(amount, 10),
    })
    .onConflictDoUpdate({
      target: [
        depositsTable.messId,
        depositsTable.consumerId,
        depositsTable.yearMonth,
        depositsTable.day,
      ],
      set: { amount: parseInt(amount, 10) },
    });
  res.json({ success: true });
});

// POST /api/mess/send-summary — admin sends monthly summary emails to all consumers
router.post("/mess/send-summary", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonth } = req.body ?? {};
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
    db.select().from(mealsTable).where(
      and(eq(mealsTable.messId, mess.id), eq(mealsTable.yearMonth, yearMonth as string)),
    ),
    db.select().from(expenseDaysTable).where(
      and(eq(expenseDaysTable.messId, mess.id), eq(expenseDaysTable.yearMonth, yearMonth as string)),
    ),
    db.select().from(depositsTable).where(
      and(eq(depositsTable.messId, mess.id), eq(depositsTable.yearMonth, yearMonth as string)),
    ),
  ]);

  const totalExpenses = expenseRows.reduce((sum, row) => {
    const items = (row.items as Array<{ amount: number }>) ?? [];
    return sum + items.reduce((s, i) => s + (i.amount ?? 0), 0);
  }, 0);

  const mealsByConsumer: Record<number, number> = {};
  for (const row of mealRows) {
    mealsByConsumer[row.consumerId] = (mealsByConsumer[row.consumerId] ?? 0) + row.count;
  }
  const totalMeals = Object.values(mealsByConsumer).reduce((s, v) => s + v, 0);
  const mealRate = totalMeals > 0 ? totalExpenses / totalMeals : 0;

  const depositsByConsumer: Record<number, number> = {};
  for (const row of depositRows) {
    depositsByConsumer[row.consumerId] = (depositsByConsumer[row.consumerId] ?? 0) + row.amount;
  }

  const withEmail = consumers.filter((c) => c.email);
  const results = await Promise.allSettled(
    withEmail.map((c) => {
      const meals    = mealsByConsumer[c.id] ?? 0;
      const cost     = meals * mealRate;
      const deposits = depositsByConsumer[c.id] ?? 0;
      const balance  = deposits - cost;
      return sendMonthlySummaryEmail(c.email!, c.name, mess.name, yearMonth as string, {
        meals, cost, deposits, balance, mealRate, totalExpenses, totalMeals,
      });
    }),
  );

  const sent   = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    req.log.error({ failed }, "Some summary emails failed to send");
  }

  res.json({ sent, total: withEmail.length });
});

// POST /api/mess/send-blended-summary — admin sends blended multi-month summary to all consumers
router.post("/mess/send-blended-summary", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, yearMonths } = req.body ?? {};
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
  if (!Array.isArray(yearMonths) || yearMonths.length === 0) {
    res.status(400).json({ error: "yearMonths[] is required" });
    return;
  }

  const consumers = await db
    .select({ id: consumersTable.id, name: consumersTable.name, email: usersTable.email })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, mess.id));

  const mealsByConsumer: Record<number, number> = {};
  let totalExpenses = 0;
  const depositsByConsumer: Record<number, number> = {};

  for (const ym of yearMonths as string[]) {
    const [mealRows, expenseRows, depositRows] = await Promise.all([
      db.select().from(mealsTable).where(
        and(eq(mealsTable.messId, mess.id), eq(mealsTable.yearMonth, ym)),
      ),
      db.select().from(expenseDaysTable).where(
        and(eq(expenseDaysTable.messId, mess.id), eq(expenseDaysTable.yearMonth, ym)),
      ),
      db.select().from(depositsTable).where(
        and(eq(depositsTable.messId, mess.id), eq(depositsTable.yearMonth, ym)),
      ),
    ]);

    for (const row of mealRows) {
      mealsByConsumer[row.consumerId] = (mealsByConsumer[row.consumerId] ?? 0) + row.count;
    }
    for (const row of expenseRows) {
      const items = (row.items as Array<{ amount: number }>) ?? [];
      totalExpenses += items.reduce((s, i) => s + (i.amount ?? 0), 0);
    }
    for (const row of depositRows) {
      depositsByConsumer[row.consumerId] = (depositsByConsumer[row.consumerId] ?? 0) + row.amount;
    }
  }

  const totalMeals = Object.values(mealsByConsumer).reduce((s, v) => s + v, 0);
  const mealRate = totalMeals > 0 ? totalExpenses / totalMeals : 0;

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const blendLabel = `${(yearMonths as string[]).length}-month blend (${(yearMonths as string[]).map((ym) => {
    const [y, m] = ym.split("-").map(Number);
    return `${monthNames[(m ?? 1) - 1]} '${(y ?? 2024).toString().slice(2)}`;
  }).join(", ")})`;

  const withEmail = consumers.filter((c) => c.email);
  const results = await Promise.allSettled(
    withEmail.map((c) => {
      const meals    = mealsByConsumer[c.id] ?? 0;
      const cost     = meals * mealRate;
      const deposits = depositsByConsumer[c.id] ?? 0;
      const balance  = deposits - cost;
      return sendMonthlySummaryEmail(c.email!, c.name, mess.name, blendLabel, {
        meals, cost, deposits, balance, mealRate, totalExpenses, totalMeals,
      });
    }),
  );

  const sent   = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) req.log.error({ failed }, "Some blended summary emails failed to send");

  res.json({ sent, total: withEmail.length });
});

export default router;
