import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, asc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";

import {
  consumersTable,
  db,
  noticeReadStatesTable,
  noticesTable,
  syncChangesTable,
  syncClientMutationsTable,
} from "../db/dbConfig.js";
import { deliverNoticePushes } from "../lib/notificationDelivery.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

type NoticeSyncOperation =
  | "notice_create"
  | "notice_update"
  | "notice_delete"
  | "notice_reorder"
  | "notifications_read";

class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const operations = new Set<NoticeSyncOperation>([
  "notice_create",
  "notice_update",
  "notice_delete",
  "notice_reorder",
  "notifications_read",
]);
const adminOperations = new Set<NoticeSyncOperation>([
  "notice_create",
  "notice_update",
  "notice_delete",
  "notice_reorder",
]);
const colors = new Set([
  "#F0FDFA",
  "#FEF3C7",
  "#DBEAFE",
  "#DCFCE7",
  "#FCE7F3",
  "#EDE9FE",
  "#FFEDD5",
]);
const toJsonValue = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const readFields = (payload: Record<string, unknown>) => {
  const title = String(payload.title ?? "").trim();
  const body = String(payload.body ?? "").trim();
  const color = String(payload.color ?? "#F0FDFA").toUpperCase();
  if (!title || title.length > 160 || !body || body.length > 5000) {
    throw new SyncRequestError("Invalid notice title or body");
  }
  if (!colors.has(color)) throw new SyncRequestError("Invalid notice color");
  return { title, body, color };
};

const getUnreadNoticeCount = async (messId: number, userId: number) => {
  const [readState] = await db
    .select({ lastReadNoticeId: noticeReadStatesTable.lastReadNoticeId })
    .from(noticeReadStatesTable)
    .where(
      and(
        eq(noticeReadStatesTable.messId, messId),
        eq(noticeReadStatesTable.userId, userId),
      ),
    )
    .limit(1);
  const unreadBoundary = readState
    ? gt(noticesTable.id, readState.lastReadNoticeId ?? 0)
    : gt(noticesTable.id, 0);
  const [result] = await db
    .select({ total: sql<number>`count(*)` })
    .from(noticesTable)
    .where(
      and(
        eq(noticesTable.messId, messId),
        unreadBoundary,
        sql`${noticesTable.createdByUserId} <> ${userId}`,
      ),
    );
  return Number(result?.total ?? 0);
};

export const syncNoticeMutation = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const clientMutationId = String(req.body?.clientMutationId ?? "").trim();
  const operation = req.body?.operation as NoticeSyncOperation;
  const payload = (req.body?.payload ?? {}) as Record<string, unknown>;
  if (!clientMutationId || clientMutationId.length > 160) {
    res.status(400).json({ error: "A valid clientMutationId is required" });
    return;
  }
  if (!operations.has(operation)) {
    res.status(400).json({ error: "Unsupported notice sync operation" });
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
          entityType: "notice",
          entityId: String(
            payload.serverId ??
              payload.localId ??
              payload.operation ??
              operation,
          ),
          operation:
            operation === "notice_create"
              ? "create"
              : operation === "notice_delete"
                ? "delete"
                : operation === "notifications_read" ||
                    operation === "notice_reorder"
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

      if (operation === "notice_create") {
        const fields = readFields(payload);
        const existing = await tx
          .select({ id: noticesTable.id })
          .from(noticesTable)
          .where(eq(noticesTable.messId, access.messId))
          .orderBy(asc(noticesTable.serialNo));
        const offset = existing.length + 1;
        if (existing.length > 0) {
          await tx
            .update(noticesTable)
            .set({ serialNo: sql`${noticesTable.serialNo} + ${offset}` })
            .where(eq(noticesTable.messId, access.messId));
          for (const [index, current] of existing.entries()) {
            await tx
              .update(noticesTable)
              .set({ serialNo: index + 2 })
              .where(
                and(
                  eq(noticesTable.id, current.id),
                  eq(noticesTable.messId, access.messId),
                ),
              );
          }
        }
        const [notice] = await tx
          .insert(noticesTable)
          .values({
            messId: access.messId,
            serialNo: 1,
            ...fields,
            createdByUserId: userId,
          })
          .returning();
        const recipients = await tx
          .select({ userId: consumersTable.userId })
          .from(consumersTable)
          .where(
            and(
              eq(consumersTable.messId, access.messId),
              isNull(consumersTable.accountDeletedAt),
            ),
          );
        body = {
          notice,
          recipientUserIds: [
            ...new Set(
              recipients.flatMap(({ userId: recipientId }) =>
                recipientId == null ? [] : [recipientId],
              ),
            ),
          ],
        };
        changeOperation = "create";
      } else if (operation === "notice_update") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId) throw new SyncRequestError("Invalid notice id");
        const [notice] = await tx
          .update(noticesTable)
          .set({ ...readFields(payload), updatedAt: new Date() })
          .where(
            and(
              eq(noticesTable.id, serverId),
              eq(noticesTable.messId, access.messId),
            ),
          )
          .returning();
        if (!notice) throw new SyncRequestError("Notice not found", 404);
        body = { notice };
      } else if (operation === "notice_delete") {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId) throw new SyncRequestError("Invalid notice id");
        await tx
          .delete(noticesTable)
          .where(
            and(
              eq(noticesTable.id, serverId),
              eq(noticesTable.messId, access.messId),
            ),
          );
        body = { success: true, serverId };
        changeOperation = "delete";
      } else if (operation === "notice_reorder") {
        const rawIds = payload.noticeIds;
        if (
          !Array.isArray(rawIds) ||
          rawIds.length === 0 ||
          rawIds.some((id) => !parsePositiveInteger(id)) ||
          new Set(rawIds).size !== rawIds.length
        ) {
          throw new SyncRequestError(
            "noticeIds must be a unique non-empty array",
          );
        }
        const noticeIds = rawIds.map((id) => parsePositiveInteger(id)!);
        const owned = await tx
          .select({ id: noticesTable.id })
          .from(noticesTable)
          .where(
            and(
              eq(noticesTable.messId, access.messId),
              inArray(noticesTable.id, noticeIds),
            ),
          );
        if (owned.length !== noticeIds.length) {
          throw new SyncRequestError("noticeIds must belong to this mess");
        }
        const offset = noticeIds.length + 1;
        await tx
          .update(noticesTable)
          .set({ serialNo: sql`${noticesTable.serialNo} + ${offset}` })
          .where(eq(noticesTable.messId, access.messId));
        for (const [index, noticeId] of noticeIds.entries()) {
          await tx
            .update(noticesTable)
            .set({ serialNo: index + 1, updatedAt: new Date() })
            .where(
              and(
                eq(noticesTable.id, noticeId),
                eq(noticesTable.messId, access.messId),
              ),
            );
        }
        const notices = await tx
          .select()
          .from(noticesTable)
          .where(eq(noticesTable.messId, access.messId))
          .orderBy(asc(noticesTable.serialNo));
        body = { notices };
        changeOperation = "upsert";
      } else {
        const [latest] = await tx
          .select({ id: max(noticesTable.id) })
          .from(noticesTable)
          .where(eq(noticesTable.messId, access.messId));
        const latestNoticeId = latest?.id == null ? null : Number(latest.id);
        await tx
          .insert(noticeReadStatesTable)
          .values({
            messId: access.messId,
            userId,
            lastReadNoticeId: latestNoticeId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              noticeReadStatesTable.messId,
              noticeReadStatesTable.userId,
            ],
            set: { lastReadNoticeId: latestNoticeId, updatedAt: new Date() },
          });
        body = { unreadCount: 0 };
      }

      const jsonBody = toJsonValue(body);
      await tx.insert(syncChangesTable).values({
        messId: access.messId,
        actorUserId: userId,
        entityType: "notice",
        entityId: String(
          payload.serverId ?? payload.localId ?? payload.noticeIds ?? operation,
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
      notice?: { id: number; title: string; body: string };
    };
    if (
      operation === "notice_create" &&
      !outcome.replayed &&
      responseBody.recipientUserIds &&
      responseBody.notice
    ) {
      void deliverNoticePushes({
        recipientUserIds: responseBody.recipientUserIds,
        messId: access.messId,
        noticeId: responseBody.notice.id,
        title: responseBody.notice.title,
        body: responseBody.notice.body,
      });
    }
    if (operation === "notice_create") {
      const { recipientUserIds: _recipientUserIds, ...publicBody } =
        responseBody;
      res.status(200).json(publicBody);
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
