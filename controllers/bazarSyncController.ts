import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  bazarAssignmentNotificationsTable,
  bazarAssignmentsTable,
  bazarItemsTable,
  consumersTable,
  db,
  syncChangesTable,
  syncClientMutationsTable,
  usersTable,
} from "../db/dbConfig.js";
import { deliverBazarAssignmentPushes } from "../lib/notificationDelivery.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

type BazarSyncOperation =
  | "item_create"
  | "item_update"
  | "item_status"
  | "item_delete"
  | "assignments_set"
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
  "notifications_read",
  "notify_members",
]);

const adminOperations = new Set<BazarSyncOperation>([
  "item_update",
  "item_delete",
  "assignments_set",
  "notify_members",
]);

const toJsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

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
            payload.serverId ?? payload.localId ?? payload.weekday ?? operation,
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
        const weekday = Number(payload.weekday);
        const name = String(payload.name ?? "").trim();
        const price = Number(payload.price ?? 0);
        const completed = payload.completed ?? false;
        if (
          !Number.isInteger(weekday) ||
          weekday < 0 ||
          weekday > 6 ||
          !name ||
          name.length > 160 ||
          !Number.isFinite(price) ||
          price < 0 ||
          typeof completed !== "boolean"
        ) {
          throw new SyncRequestError("Invalid bazar item data");
        }
        const [item] = await tx
          .insert(bazarItemsTable)
          .values({
            messId: access.messId,
            weekday,
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
        const [item] = await tx
          .update(bazarItemsTable)
          .set({ name, price, updatedAt: new Date() })
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
            ),
          )
          .returning();
        if (!item) throw new SyncRequestError("Bazar item not found", 404);
        body = { item };
      } else if (operation === "item_status") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId || typeof payload.completed !== "boolean") {
          throw new SyncRequestError("Invalid bazar completion update");
        }
        const [item] = await tx
          .update(bazarItemsTable)
          .set({ isCompleted: payload.completed, updatedAt: new Date() })
          .where(
            and(
              eq(bazarItemsTable.id, serverId),
              eq(bazarItemsTable.messId, access.messId),
            ),
          )
          .returning();
        if (!item) throw new SyncRequestError("Bazar item not found", 404);
        body = { item };
      } else if (operation === "item_delete") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId) throw new SyncRequestError("Invalid bazar item id");
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
        const weekday = Number(payload.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          throw new SyncRequestError("Invalid notification weekday");
        }
        const [item] = await tx
          .select({ id: bazarItemsTable.id })
          .from(bazarItemsTable)
          .where(
            and(
              eq(bazarItemsTable.messId, access.messId),
              eq(bazarItemsTable.weekday, weekday),
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
            weekday,
          })),
        );
        body = {
          notifiedCount: recipientUserIds.length,
          recipientUserIds,
          weekday,
        };
        changeOperation = "create";
      }

      const jsonBody = toJsonValue(body);
      await tx.insert(syncChangesTable).values({
        messId: access.messId,
        actorUserId: userId,
        entityType: "bazar",
        entityId: String(
          payload.serverId ?? payload.localId ?? payload.weekday ?? operation,
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
      weekday?: number;
    };
    if (
      operation === "notify_members" &&
      !outcome.replayed &&
      responseBody.recipientUserIds &&
      responseBody.weekday !== undefined
    ) {
      void deliverBazarAssignmentPushes({
        recipientUserIds: responseBody.recipientUserIds,
        messId: access.messId,
        weekday: responseBody.weekday,
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
