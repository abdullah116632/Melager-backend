import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  bazarAssignmentsTable,
  bazarItemsTable,
  consumersTable,
  db,
  expenseDaysTable,
  notificationsTable,
  usersTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

const MAX_ITEM_NAME_LENGTH = 160;
const WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

const parseWeekday = (value: unknown): number | null => {
  const weekday = Number(value);
  return Number.isInteger(weekday) && WEEKDAYS.has(weekday) ? weekday : null;
};

const parsePrice = (value: unknown): number | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) return null;
  const price = Number(raw);
  return Number.isFinite(price) ? price : null;
};

const readItemFields = (body: unknown) => {
  const input = body as { name?: unknown; price?: unknown } | null;
  const name = String(input?.name ?? "").trim();
  const price = parsePrice(input?.price);
  if (!name || name.length > MAX_ITEM_NAME_LENGTH) {
    return { error: `name is required and must be at most ${MAX_ITEM_NAME_LENGTH} characters` };
  }
  if (price === null) {
    return { error: "price must be a non-negative number with up to 3 decimals" };
  }
  return { name, price };
};

export const getBazar = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [items, assignments] = await Promise.all([
    db
      .select()
      .from(bazarItemsTable)
      .where(eq(bazarItemsTable.messId, access.messId))
      .orderBy(asc(bazarItemsTable.weekday), desc(bazarItemsTable.id)),
    db
      .select({
        id: bazarAssignmentsTable.id,
        weekday: bazarAssignmentsTable.weekday,
        consumerId: consumersTable.id,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(bazarAssignmentsTable)
      .innerJoin(consumersTable, eq(bazarAssignmentsTable.consumerId, consumersTable.id))
      .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
      .where(eq(bazarAssignmentsTable.messId, access.messId))
      .orderBy(asc(bazarAssignmentsTable.weekday), asc(bazarAssignmentsTable.id)),
  ]);

  res.json({ items, assignments });
};

export const createBazarItem = async (req: AuthedRequest, res: Response) => {
  const input = readItemFields(req.body);
  const weekday = parseWeekday(req.body?.weekday);
  if ("error" in input || weekday === null) {
    res.status(400).json({
      error: "error" in input ? input.error : "weekday must be an integer from 0 to 6",
    });
    return;
  }
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [item] = await db
    .insert(bazarItemsTable)
    .values({
      messId: access.messId,
      weekday,
      name: input.name,
      price: input.price,
      createdByUserId: req.auth!.userId,
    })
    .returning();
  res.status(201).json({ item });
};

export const updateBazarItem = async (req: AuthedRequest, res: Response) => {
  const input = readItemFields(req.body);
  const itemId = parsePositiveInteger(req.params.id);
  if ("error" in input || !itemId) {
    res.status(400).json({
      error: "error" in input ? input.error : "item id is required",
    });
    return;
  }
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [item] = await db
    .update(bazarItemsTable)
    .set({ name: input.name, price: input.price, updatedAt: new Date() })
    .where(and(eq(bazarItemsTable.id, itemId), eq(bazarItemsTable.messId, access.messId)))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Bazar item not found" });
    return;
  }
  res.json({ item });
};

export const updateBazarItemStatus = async (req: AuthedRequest, res: Response) => {
  const itemId = parsePositiveInteger(req.params.id);
  const completed = req.body?.completed;
  if (!itemId || typeof completed !== "boolean") {
    res.status(400).json({ error: "item id and completed status are required" });
    return;
  }
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [item] = await db
    .update(bazarItemsTable)
    .set({ isCompleted: completed, updatedAt: new Date() })
    .where(and(eq(bazarItemsTable.id, itemId), eq(bazarItemsTable.messId, access.messId)))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Bazar item not found" });
    return;
  }
  res.json({ item });
};

export const deleteBazarItem = async (req: AuthedRequest, res: Response) => {
  const itemId = parsePositiveInteger(req.params.id);
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId, {
    adminOnly: true,
  });
  if (!itemId || !access.ok) {
    res.status(!access.ok ? access.status : 400).json({
      error: !access.ok ? access.error : "item id is required",
    });
    return;
  }

  const [item] = await db
    .delete(bazarItemsTable)
    .where(and(eq(bazarItemsTable.id, itemId), eq(bazarItemsTable.messId, access.messId)))
    .returning({ id: bazarItemsTable.id });
  if (!item) {
    res.status(404).json({ error: "Bazar item not found" });
    return;
  }
  res.json({ success: true });
};

export const deleteBazarItems = async (req: AuthedRequest, res: Response) => {
  const weekday = parseWeekday(req.query.weekday);
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId, {
    adminOnly: true,
  });
  if (weekday === null || !access.ok) {
    res.status(!access.ok ? access.status : 400).json({
      error: !access.ok ? access.error : "weekday is required",
    });
    return;
  }

  const deleted = await db
    .delete(bazarItemsTable)
    .where(and(eq(bazarItemsTable.messId, access.messId), eq(bazarItemsTable.weekday, weekday)))
    .returning({ id: bazarItemsTable.id });
  res.json({ success: true, deletedCount: deleted.length });
};

export const addBazarItemsToExpense = async (req: AuthedRequest, res: Response) => {
  const { yearMonth, day, preview } = req.body ?? {};
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  const parsedDay = Number(day);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth)) || !Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31) {
    res.status(400).json({ error: "valid yearMonth and day are required" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [bazarItems, expense] = await Promise.all([
      tx.select({ name: bazarItemsTable.name, price: bazarItemsTable.price })
        .from(bazarItemsTable)
        .where(eq(bazarItemsTable.messId, access.messId)),
      tx.select({ items: expenseDaysTable.items })
        .from(expenseDaysTable)
        .where(and(
          eq(expenseDaysTable.messId, access.messId),
          eq(expenseDaysTable.yearMonth, String(yearMonth)),
          eq(expenseDaysTable.day, parsedDay),
        )),
    ]);
    const existingItems = expense[0]?.items ?? [];
    const existingKeys = new Set(existingItems.map((item) => `${item.name}\u0000${item.amount}`));
    const newItems = bazarItems.filter((item) => {
      const key = `${item.name}\u0000${item.price}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    }).map((item) => ({ id: randomUUID(), name: item.name, amount: item.price }));

    if (!preview && newItems.length > 0) {
      const mergedItems = [...existingItems, ...newItems];
      await tx.insert(expenseDaysTable).values({
        messId: access.messId,
        yearMonth: String(yearMonth),
        day: parsedDay,
        items: mergedItems,
      }).onConflictDoUpdate({
        target: [expenseDaysTable.messId, expenseDaysTable.yearMonth, expenseDaysTable.day],
        set: { items: mergedItems },
      });
    }
    return { newItems, alreadyAddedAll: newItems.length === 0 };
  });

  res.json({ ...result, added: !preview && result.newItems.length > 0 });
};

export const assignBazarMember = async (req: AuthedRequest, res: Response) => {
  const weekday = parseWeekday(req.body?.weekday);
  const consumerId = parsePositiveInteger(req.body?.consumerId);
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  if (weekday === null || !consumerId) {
    res.status(400).json({ error: "weekday and consumerId are required" });
    return;
  }

  const [consumer] = await db
    .select({ id: consumersTable.id, userId: consumersTable.userId, name: usersTable.name, email: usersTable.email })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(
      and(
        eq(consumersTable.id, consumerId),
        eq(consumersTable.messId, access.messId),
        isNull(consumersTable.accountDeletedAt),
      ),
    );
  if (!consumer) {
    res.status(404).json({ error: "Active mess member not found" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [assignment] = await tx
      .insert(bazarAssignmentsTable)
      .values({
        messId: access.messId,
        weekday,
        consumerId,
        assignedByUserId: req.auth!.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (assignment && consumer.userId) {
      await tx
        .insert(notificationsTable)
        .values(buildBazarAssignmentNotification(access.messId, consumer.userId, weekday));
    }
    return assignment ?? null;
  });

  if (!result) {
    res.status(409).json({ error: "This member is already assigned for that day" });
    return;
  }
  res.status(201).json({ assignment: { ...result, name: consumer.name, email: consumer.email } });
};

export const assignBazarMembers = async (req: AuthedRequest, res: Response) => {
  const weekday = parseWeekday(req.body?.weekday);
  const consumerIds = req.body?.consumerIds;
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  if (
    weekday === null ||
    !Array.isArray(consumerIds) ||
    consumerIds.length === 0 ||
    consumerIds.some((id: unknown) => !parsePositiveInteger(id)) ||
    new Set(consumerIds).size !== consumerIds.length
  ) {
    res.status(400).json({ error: "weekday and a unique consumerIds array are required" });
    return;
  }

  const consumers = await db
    .select({
      id: consumersTable.id,
      userId: consumersTable.userId,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(
      and(
        eq(consumersTable.messId, access.messId),
        isNull(consumersTable.accountDeletedAt),
      ),
    );
  const selectedIds = consumerIds.map((id: number) => parsePositiveInteger(id)!);
  const selectedConsumers = consumers.filter((consumer) => selectedIds.includes(consumer.id));
  if (selectedConsumers.length !== selectedIds.length) {
    res.status(404).json({ error: "One or more active mess members were not found" });
    return;
  }

  const created = await db.transaction(async (tx) => {
    const assignments = [];
    for (const consumer of selectedConsumers) {
      const [assignment] = await tx
        .insert(bazarAssignmentsTable)
        .values({
          messId: access.messId,
          weekday,
          consumerId: consumer.id,
          assignedByUserId: req.auth!.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!assignment) continue;
      assignments.push({ ...assignment, name: consumer.name, email: consumer.email });
      if (consumer.userId) {
        await tx
          .insert(notificationsTable)
          .values(buildBazarAssignmentNotification(access.messId, consumer.userId, weekday));
      }
    }
    return assignments;
  });

  res.status(201).json({ assignments: created });
};

export const unassignBazarMember = async (req: AuthedRequest, res: Response) => {
  const assignmentId = parsePositiveInteger(req.params.id);
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId, {
    adminOnly: true,
  });
  if (!assignmentId || !access.ok) {
    res.status(!access.ok ? access.status : 400).json({
      error: !access.ok ? access.error : "assignment id is required",
    });
    return;
  }
  const [assignment] = await db
    .delete(bazarAssignmentsTable)
    .where(and(eq(bazarAssignmentsTable.id, assignmentId), eq(bazarAssignmentsTable.messId, access.messId)))
    .returning({ id: bazarAssignmentsTable.id });
  if (!assignment) {
    res.status(404).json({ error: "Bazar assignment not found" });
    return;
  }
  res.json({ success: true });
};

const weekdayName = (weekday: number) =>
  ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][weekday] ?? "selected day";

const buildBazarAssignmentNotification = (
  messId: number,
  userId: number,
  weekday: number,
) => ({
  messId,
  userId,
  type: "bazar_assignment" as const,
  title: "Bazar duty assigned",
  body: `You have been assigned for ${weekdayName(weekday)} bazar.`,
});
