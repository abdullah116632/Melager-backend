import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  expenseDaysTable,
  syncClientMutationsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { emitToMess } from "../realtime/socket.js";

interface ExpenseItem {
  id: string;
  name: string;
  amount: number;
}

const normalizeExpenseItems = (items: unknown[]): ExpenseItem[] =>
  items.map((item: any) => ({
    id: String(item?.id ?? ""),
    name: String(item?.name ?? "").trim(),
    amount: Number(item?.amount),
  }));

const expenseItemsHash = (items: ExpenseItem[]) =>
  createHash("sha256").update(JSON.stringify(items)).digest("hex");

export const syncExpenseDay = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId,
    id = String(req.body?.clientMutationId ?? ""),
    p = req.body?.payload ?? {},
    ym = String(p.yearMonth ?? ""),
    day = Number(p.day),
    items = Array.isArray(p.items) ? p.items : [],
    normalizedItems = normalizeExpenseItems(items);
  if (
    !id ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) ||
    !Number.isInteger(day) ||
    day < 1 ||
    items.some(
      (x: any) =>
        !String(x?.id ?? "") ||
        !String(x?.name ?? "").trim() ||
        !/^\d+(?:\.\d{1,3})?$/.test(String(x?.amount ?? "")),
    )
  ) {
    res.status(400).json({ error: "Invalid expense data" });
    return;
  }
  const access = await resolveMessAccess(userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ p, messId: access.messId }))
    .digest("hex");
  try {
    const body = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(syncClientMutationsTable)
        .values({
          clientMutationId: id,
          userId,
          messId: access.messId,
          entityType: "expense",
          entityId: `${ym}:${day}`,
          operation: "upsert",
          requestHash: hash,
          expiresAt: new Date(Date.now() + 2592000000),
        })
        .onConflictDoNothing()
        .returning();
      if (!r) {
        const [o] = await tx
          .select()
          .from(syncClientMutationsTable)
          .where(
            and(
              eq(syncClientMutationsTable.userId, userId),
              eq(syncClientMutationsTable.clientMutationId, id),
            ),
          )
          .limit(1);
        if (!o?.completedAt || o.requestHash !== hash)
          throw Object.assign(new Error("Duplicate mutation conflict"), {
            status: 409,
          });
        return o.responseBody;
      }
      const [current] = await tx
        .select({ items: expenseDaysTable.items })
        .from(expenseDaysTable)
        .where(
          and(
            eq(expenseDaysTable.messId, access.messId),
            eq(expenseDaysTable.yearMonth, ym),
            eq(expenseDaysTable.day, day),
          ),
        )
        .limit(1);
      const currentHash = current
        ? expenseItemsHash(normalizeExpenseItems(current.items ?? []))
        : "empty";
      if (currentHash !== String(p.baseHash ?? "empty"))
        throw Object.assign(new Error("Expense changed on another device"), {
          status: 409,
        });
      await tx
        .insert(expenseDaysTable)
        .values({
          messId: access.messId,
          yearMonth: ym,
          day,
          items: normalizedItems,
        })
        .onConflictDoUpdate({
          target: [
            expenseDaysTable.messId,
            expenseDaysTable.yearMonth,
            expenseDaysTable.day,
          ],
          set: { items: normalizedItems },
        });
      const result = { success: true };
      await tx
        .update(syncClientMutationsTable)
        .set({
          responseStatus: 200,
          responseBody: result,
          completedAt: new Date(),
        })
        .where(eq(syncClientMutationsTable.id, r.id));
      return result;
    });
    emitToMess(access.messId, "expenses:updated", {
      messId: access.messId,
      yearMonth: ym,
    });
    res.json(body);
  } catch (e) {
    const s = (e as any).status;
    if (s) {
      res.status(s).json({ error: (e as Error).message });
      return;
    }
    throw e;
  }
};
