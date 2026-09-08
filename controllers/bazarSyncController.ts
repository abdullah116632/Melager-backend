import { createHash, randomUUID } from "node:crypto";
import type { Response } from "express";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import {
  bazarAssignmentNotificationsTable,
  bazarAssignmentsTable,
  bazarItemsTable,
  consumersTable,
  db,
  expenseDaysTable,
  syncChangesTable,
  syncClientMutationsTable,
  usersTable,
} from "../db/dbConfig.js";
import { deliverBazarAssignmentPushes } from "../lib/notificationDelivery.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { updatedAtMatches } from "../utils/syncVersionUtils.js";
import {
  bazarWeekdayFromDate,
  parseBazarDate,
} from "../utils/bazarDateUtils.js";
import { emitToMess } from "../realtime/socket.js";

type BazarSyncOperation =
  | "item_create"
  | "item_update"
  | "item_status"
  | "item_delete"
  | "assignments_set"
  | "add_to_expense"
  | "notifications_read"
  | "notify_members";

class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const operations = new Set<BazarSyncOperation>([
  "item_create",
  "item_update",
  "item_status",
  "item_delete",
  "assignments_set",
  "add_to_expense",
  "notifications_read",
  "notify_members",
]);

// Every mess member maintains the shopping list itself. Duty assignments and
// anything that touches the expense ledger stay with the manager.
const adminOperations = new Set<BazarSyncOperation>([
  "assignments_set",
  "add_to_expense",
  "notify_members",
]);

const toJsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const DUPLICATE_NAME_ERROR =
  "An item with this name is already on that day's list";

/** True when another item on the same day already carries this exact name. */
const dayHasItemNamed = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  messId: number,
  bazarDate: string,
  name: string,
  exceptItemId?: number,
) => {
  const [existing] = await tx
    .select({ id: bazarItemsTable.id })
    .from(bazarItemsTable)
    .where(
      and(
        eq(bazarItemsTable.messId, messId),
        eq(bazarItemsTable.bazarDate, bazarDate),
        eq(bazarItemsTable.name, name),
        ...(exceptItemId ? [ne(bazarItemsTable.id, exceptItemId)] : []),
      ),
    )
    .limit(1);
  return Boolean(existing);
};

const readBaseUpdatedAt = (payload: Record<string, unknown>): Date => {
  const value = new Date(String(payload.baseUpdatedAt ?? ""));
  if (Number.isNaN(value.getTime())) {
    throw new SyncRequestError("A valid baseUpdatedAt is required");
  }
  return value;
};

export const syncBazarMutation = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const clientMutationId = String(req.body?.clientMutationId ?? "").trim();
  const operation = req.body?.operation as BazarSyncOperation;
  const payload = (req.body?.payload ?? {}) as Record<string, unknown>;
  if (!clientMutationId || clientMutationId.length > 160) {
    res.status(400).json({ error: "A valid clientMutationId is required" });
    return;
  }
  if (!operations.has(operation)) {
    res.status(400).json({ error: "Unsupported bazar sync operation" });
    return;
  }

  const access = await resolveMessAccess(userId, req.body?.messId, {
    adminOnly: adminOperations.has(operation),
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const requestHash = createHash("sha256")
    .update(JSON.stringify({ messId: access.messId, operation, payload }))
    .digest("hex");

  try {
    const outcome = await db.transaction(async (tx) => {
      const [reservation] = await tx
        .insert(syncClientMutationsTable)
        .values({
          clientMutationId,
          userId,
          messId: access.messId,
          entityType: "bazar",
          entityId: String(
            payload.serverId ??
              payload.localId ??
              payload.bazarDate ??
              payload.weekday ??
              operation,
          ),
          operation:
            operation === "item_create"
              ? "create"
              : operation === "item_delete"
                ? "delete"
                : operation === "notifications_read" ||
                    operation === "notify_members" ||
                    operation === "assignments_set"
                  ? "command"
                  : "update",
          requestHash,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing()
        .returning({ id: syncClientMutationsTable.id });

      if (!reservation) {
        const [existing] = await tx
          .select({
            requestHash: syncClientMutationsTable.requestHash,
            responseBody: syncClientMutationsTable.responseBody,
            completedAt: syncClientMutationsTable.completedAt,
          })
          .from(syncClientMutationsTable)
          .where(
            and(
              eq(syncClientMutationsTable.userId, userId),
              eq(syncClientMutationsTable.clientMutationId, clientMutationId),
            ),
          )
          .limit(1);
        if (!existing || !existing.completedAt) {
          throw new SyncRequestError("Mutation is still being processed", 409);
        }
        if (existing.requestHash !== requestHash) {
          throw new SyncRequestError(
            "clientMutationId was already used for different data",
            409,
          );
        }
        return { body: existing.responseBody, replayed: true };
      }

      let body: Record<string, unknown>;
      let changeOperation: "create" | "update" | "delete" | "upsert" = "update";

      if (operation === "item_create") {
        const bazarDate = parseBazarDate(payload.bazarDate);
        const name = String(payload.name ?? "").trim();
        const price = Number(payload.price ?? 0);
        const completed = payload.completed ?? false;
        if (
          !bazarDate ||
          !name ||
          name.length > 160 ||
          !Number.isFinite(price) ||
          price < 0 ||
          typeof completed !== "boolean"
        ) {
          throw new SyncRequestError("Invalid bazar item data");
        }
        if (await dayHasItemNamed(tx, access.messId, bazarDate, name)) {
          throw new SyncRequestError(DUPLICATE_NAME_ERROR, 409);
        }
        const [item] = await tx
          .insert(bazarItemsTable)
          .values({
            messId: access.messId,
            bazarDate,
            name,
            price,
            isCompleted: completed,
            createdByUserId: userId,
          })
          .returning();
        body = { item };
        changeOperation = "create";
      } else if (operation === "item_update") {
        const serverId = parsePositiveInteger(payload.serverId);
        const name = String(payload.name ?? "").trim();
        const price = Number(payload.price ?? 0);
        if (
          !serverId ||
          !name ||
          name.length > 160 ||
          !Number.isFinite(price) ||
          price < 0
        ) {
          throw new SyncRequestError("Invalid bazar item update");
        }
        const baseUpdatedAt = readBaseUpdatedAt(payload);
        if (
          payload.completed !== undefined &&
          typeof payload.completed !== "boolean"
        ) {
          throw new SyncRequestError("Invalid bazar completion value");
        }
        const [target] = await tx
          .select({ bazarDate: bazarItemsTable.bazarDate })
          .from(bazarItemsTable)
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
            ),
          )
          .limit(1);
        if (!target) {
          throw new SyncRequestError("Bazar item not found", 404);
        }
        if (
          await dayHasItemNamed(
            tx,
            access.messId,
            target.bazarDate,
            name,
            serverId,
          )
        ) {
          throw new SyncRequestError(DUPLICATE_NAME_ERROR, 409);
        }
        const [item] = await tx
          .update(bazarItemsTable)
          .set({
            name,
            price,
            ...(typeof payload.completed === "boolean"
              ? { isCompleted: payload.completed }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
              updatedAtMatches(bazarItemsTable.updatedAt, baseUpdatedAt),
            ),
          )
          .returning();
        if (!item) {
          const [current] = await tx
            .select({ id: bazarItemsTable.id })
            .from(bazarItemsTable)
            .where(
              and(
                eq(bazarItemsTable.id, serverId),
                eq(bazarItemsTable.messId, access.messId),
              ),
            )
            .limit(1);
          throw new SyncRequestError(
            current
              ? "Bazar item changed on another device"
              : "Bazar item not found",
            current ? 409 : 404,
          );
        }
        body = { item };
      } else if (operation === "item_status") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId || typeof payload.completed !== "boolean") {
          throw new SyncRequestError("Invalid bazar completion update");
        }
        const baseUpdatedAt = readBaseUpdatedAt(payload);
        const [item] = await tx
          .update(bazarItemsTable)
          .set({ isCompleted: payload.completed, updatedAt: new Date() })
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
              updatedAtMatches(bazarItemsTable.updatedAt, baseUpdatedAt),
            ),
          )
          .returning();
        if (!item) {
          const [current] = await tx
            .select({ id: bazarItemsTable.id })
            .from(bazarItemsTable)
            .where(
              and(
                eq(bazarItemsTable.id, serverId),
                eq(bazarItemsTable.messId, access.messId),
              ),
            )
            .limit(1);
          throw new SyncRequestError(
            current
              ? "Bazar item changed on another device"
              : "Bazar item not found",
            current ? 409 : 404,
          );
        }
        body = { item };
      } else if (operation === "item_delete") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId) throw new SyncRequestError("Invalid bazar item id");
        // Removing an item is intent-based, not value-based: "take this off
        // the list" stays correct no matter who last edited its name or price.
        // Version-checking here turned a concurrent edit into a 409, which the
        // sync engine treats as permanent and drops, so the row lived on
        // server-side while the device showed it gone. Deleting an already
        // deleted row is likewise a success, not an error.
        await tx
          .delete(bazarItemsTable)
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
            ),
          );
        body = { success: true, serverId };
        changeOperation = "delete";
      } else if (operation === "assignments_set") {
        const weekday = Number(payload.weekday);
        const rawConsumerIds = payload.consumerIds;
        if (
          !Number.isInteger(weekday) ||
          weekday < 0 ||
          weekday > 6 ||
          !Array.isArray(rawConsumerIds)
        ) {
          throw new SyncRequestError("Invalid assignment data");
        }
        const consumerIds = [
          ...new Set(rawConsumerIds.map((value) => Number(value))),
        ];
        if (consumerIds.some((id) => !Number.isInteger(id) || id <= 0)) {
          throw new SyncRequestError("Invalid assignment member");
        }
        const baseConsumerIds = Array.isArray(payload.baseConsumerIds)
          ? payload.baseConsumerIds.map(Number).sort((a, b) => a - b)
          : null;
        if (
          !baseConsumerIds ||
          baseConsumerIds.some((id) => !Number.isInteger(id) || id <= 0)
        ) {
          throw new SyncRequestError(
            "A valid baseConsumerIds array is required",
          );
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${access.messId}, ${10_000 + weekday})`,
        );
        const currentAssignments = await tx
          .select({ consumerId: bazarAssignmentsTable.consumerId })
          .from(bazarAssignmentsTable)
          .where(
            and(
              eq(bazarAssignmentsTable.messId, access.messId),
              eq(bazarAssignmentsTable.weekday, weekday),
            ),
          );
        const currentConsumerIds = currentAssignments
          .map((item) => item.consumerId)
          .sort((a, b) => a - b);
        if (
          currentConsumerIds.length !== baseConsumerIds.length ||
          currentConsumerIds.some(
            (consumerId, index) => consumerId !== baseConsumerIds[index],
          )
        ) {
          throw new SyncRequestError(
            "Bazar assignments changed on another device",
            409,
          );
        }
        const selectedConsumers =
          consumerIds.length === 0
            ? []
            : await tx
                .select({ id: consumersTable.id })
                .from(consumersTable)
                .where(
                  and(
                    eq(consumersTable.messId, access.messId),
                    inArray(consumersTable.id, consumerIds),
                    isNull(consumersTable.accountDeletedAt),
                  ),
                );
        if (selectedConsumers.length !== consumerIds.length) {
          throw new SyncRequestError(
            "One or more active mess members were not found",
            404,
          );
        }
        await tx
          .delete(bazarAssignmentsTable)
          .where(
            and(
              eq(bazarAssignmentsTable.messId, access.messId),
              eq(bazarAssignmentsTable.weekday, weekday),
            ),
          );
        if (consumerIds.length > 0) {
          await tx.insert(bazarAssignmentsTable).values(
            consumerIds.map((consumerId) => ({
              messId: access.messId,
              weekday,
              consumerId,
              assignedByUserId: userId,
            })),
          );
        }
        const assignments = await tx
          .select({
            id: bazarAssignmentsTable.id,
            weekday: bazarAssignmentsTable.weekday,
            consumerId: bazarAssignmentsTable.consumerId,
            name: usersTable.name,
            email: usersTable.email,
          })
          .from(bazarAssignmentsTable)
          .innerJoin(
            consumersTable,
            eq(bazarAssignmentsTable.consumerId, consumersTable.id),
          )
          .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
          .where(
            and(
              eq(bazarAssignmentsTable.messId, access.messId),
              eq(bazarAssignmentsTable.weekday, weekday),
            ),
          );
        body = { assignments, weekday };
        changeOperation = "upsert";
      } else if (operation === "add_to_expense") {
        const bazarDate = parseBazarDate(payload.bazarDate);
        if (!bazarDate) {
          throw new SyncRequestError("A valid bazarDate is required");
        }
        const yearMonth = bazarDate.slice(0, 7);
        const day = Number(bazarDate.slice(8, 10));
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${access.messId}, ${20_000 + day})`,
        );
        const [bazarItems, existingExpense] = await Promise.all([
          tx
            .select({
              name: bazarItemsTable.name,
              price: bazarItemsTable.price,
            })
            .from(bazarItemsTable)
            .where(
              and(
                eq(bazarItemsTable.messId, access.messId),
                eq(bazarItemsTable.bazarDate, bazarDate),
              ),
            ),
          tx
            .select({ items: expenseDaysTable.items })
            .from(expenseDaysTable)
            .where(
              and(
                eq(expenseDaysTable.messId, access.messId),
                eq(expenseDaysTable.yearMonth, yearMonth),
                eq(expenseDaysTable.day, day),
              ),
            )
            .limit(1),
        ]);
        const existingItems = existingExpense[0]?.items ?? [];
        // Name+amount identifies an entry: the expense stores copies, so an
        // item deleted from the bazar list stays booked and must not re-add.
        const existingKeys = new Set(
          existingItems.map((item) => `${item.name}\u0000${item.amount}`),
        );
        const alreadyAddedItems: Array<{ name: string; amount: number }> = [];
        const seenKeys = new Set<string>();
        const newItems = bazarItems
          .filter((item) => {
            const key = `${item.name}\u0000${item.price}`;
            if (existingKeys.has(key)) {
              alreadyAddedItems.push({ name: item.name, amount: item.price });
              return false;
            }
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          })
          .map((item) => ({
            id: randomUUID(),
            name: item.name,
            amount: item.price,
          }));
        if (newItems.length > 0) {
          const mergedItems = [...existingItems, ...newItems];
          await tx
            .insert(expenseDaysTable)
            .values({
              messId: access.messId,
              yearMonth,
              day,
              items: mergedItems,
            })
            .onConflictDoUpdate({
              target: [
                expenseDaysTable.messId,
                expenseDaysTable.yearMonth,
                expenseDaysTable.day,
              ],
              set: { items: mergedItems },
            });
        }
        body = {
          newItems,
          alreadyAddedItems,
          alreadyAddedAll: newItems.length === 0,
          added: newItems.length > 0,
          yearMonth,
        };
        changeOperation = "upsert";
      } else if (operation === "notifications_read") {
        await tx
          .update(bazarAssignmentNotificationsTable)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(bazarAssignmentNotificationsTable.messId, access.messId),
              eq(bazarAssignmentNotificationsTable.userId, userId),
              isNull(bazarAssignmentNotificationsTable.readAt),
            ),
          );
        body = { unreadCount: 0 };
      } else {
        const bazarDate = parseBazarDate(payload.bazarDate);
        if (!bazarDate) {
          throw new SyncRequestError("Invalid notification bazarDate");
        }
        const weekday = bazarWeekdayFromDate(bazarDate);
        const [item] = await tx
          .select({ id: bazarItemsTable.id })
          .from(bazarItemsTable)
          .where(
            and(
              eq(bazarItemsTable.messId, access.messId),
              eq(bazarItemsTable.bazarDate, bazarDate),
            ),
          )
          .limit(1);
        if (!item) {
          throw new SyncRequestError(
            "Add at least one bazar item before notifying assigned members",
          );
        }
        const recipients = await tx
          .select({ userId: consumersTable.userId })
          .from(bazarAssignmentsTable)
          .innerJoin(
            consumersTable,
            eq(bazarAssignmentsTable.consumerId, consumersTable.id),
          )
          .where(
            and(
              eq(bazarAssignmentsTable.messId, access.messId),
              eq(bazarAssignmentsTable.weekday, weekday),
              isNull(consumersTable.accountDeletedAt),
            ),
          );
        const recipientUserIds = [
          ...new Set(
            recipients.flatMap(({ userId: recipientId }) =>
              recipientId == null ? [] : [recipientId],
            ),
          ),
        ];
        if (recipientUserIds.length === 0) {
          throw new SyncRequestError("No assigned members with an app account");
        }
        await tx.insert(bazarAssignmentNotificationsTable).values(
          recipientUserIds.map((recipientId) => ({
            messId: access.messId,
            userId: recipientId,
            bazarDate,
          })),
        );
        body = {
          notifiedCount: recipientUserIds.length,
          recipientUserIds,
          bazarDate,
        };
        changeOperation = "create";
      }

      const jsonBody = toJsonValue(body);
      await tx.insert(syncChangesTable).values({
        messId: access.messId,
        actorUserId: userId,
        entityType: "bazar",
        entityId: String(
          payload.serverId ??
            payload.localId ??
            payload.bazarDate ??
            payload.weekday ??
            operation,
        ),
        operation: changeOperation,
        payload: { operation, result: jsonBody },
      });
      await tx
        .update(syncClientMutationsTable)
        .set({
          responseStatus: 200,
          responseBody: jsonBody,
          completedAt: new Date(),
        })
        .where(eq(syncClientMutationsTable.id, reservation.id));
      return { body: jsonBody, replayed: false };
    });

    const responseBody = outcome.body as Record<string, unknown> & {
      recipientUserIds?: number[];
      bazarDate?: string;
    };
    if (
      operation === "notify_members" &&
      !outcome.replayed &&
      responseBody.recipientUserIds &&
      responseBody.bazarDate !== undefined
    ) {
      void deliverBazarAssignmentPushes({
        recipientUserIds: responseBody.recipientUserIds,
        messId: access.messId,
        bazarDate: responseBody.bazarDate,
      });
    }
    if (
      operation === "add_to_expense" &&
      !outcome.replayed &&
      responseBody.added === true
    ) {
      emitToMess(access.messId, "expenses:updated", {
        messId: access.messId,
        yearMonth: responseBody.yearMonth,
      });
    }
    if (operation === "notify_members") {
      const { recipientUserIds: _recipientUserIds, ...publicBody } =
        responseBody;
      res.json(publicBody);
      return;
    }
    res.json(outcome.body);
  } catch (error) {
    if (error instanceof SyncRequestError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
};
