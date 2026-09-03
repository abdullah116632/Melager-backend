import type { Response } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  bazarAssignmentsTable,
  bazarItemsTable,
  consumersTable,
  db,
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
      .orderBy(asc(bazarItemsTable.weekday), asc(bazarItemsTable.id)),
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
      await tx.insert(notificationsTable).values({
        messId: access.messId,
        userId: consumer.userId,
        type: "bazar_assignment",
        title: "Bazar duty assigned",
        body: `You have been assigned for ${weekdayName(weekday)} bazar.`,
      });
    }
    return assignment ?? null;
  });

  if (!result) {
    res.status(409).json({ error: "This member is already assigned for that day" });
    return;
  }
  res.status(201).json({ assignment: { ...result, name: consumer.name, email: consumer.email } });
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
