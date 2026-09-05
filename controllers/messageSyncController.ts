import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  consumersTable,
  db,
  messagesTable,
  syncClientMutationsTable,
  usersTable,
} from "../db/dbConfig.js";
import { deliverMessagePushes } from "../lib/notificationDelivery.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { emitToMess, isUserViewingConversation } from "../realtime/socket.js";
export const syncMessage = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId,
    id = String(req.body?.clientMutationId ?? ""),
    body = String(req.body?.body ?? "").trim();
  if (!id || !body || body.length > 2000) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }
  const access = await resolveMessAccess(userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ body, messId: access.messId }))
    .digest("hex");
  try {
    const result = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(syncClientMutationsTable)
        .values({
          clientMutationId: id,
          userId,
          messId: access.messId,
          entityType: "message",
          entityId: id,
          operation: "create",
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
          throw Object.assign(new Error("Duplicate message conflict"), {
            status: 409,
          });
        return {
          response: o.responseBody as { message: { id: number } },
          isNew: false as const,
          pushRecipientUserIds: [] as number[],
        };
      }
      const [sender] = await tx
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const [m] = await tx
        .insert(messagesTable)
        .values({ messId: access.messId, senderUserId: userId, body })
        .returning();
      const senderName = sender?.name ?? "You";
      const out = {
        message: { ...m!, senderName, clientMutationId: id },
      };
      const recipients = await tx
        .select({ userId: consumersTable.userId })
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.messId, access.messId),
            isNull(consumersTable.accountDeletedAt),
            sql`${consumersTable.userId} is not null`,
          ),
        );
      const pushRecipientUserIds = [
        ...new Set(
          recipients.flatMap((recipient) =>
            recipient.userId == null ? [] : [recipient.userId],
          ),
        ),
      ].filter(
        (recipientUserId) =>
          recipientUserId !== userId &&
          !isUserViewingConversation(access.messId, recipientUserId),
      );
      await tx
        .update(syncClientMutationsTable)
        .set({
          responseStatus: 200,
          responseBody: out,
          completedAt: new Date(),
        })
        .where(eq(syncClientMutationsTable.id, r.id));
      return { response: out, isNew: true as const, pushRecipientUserIds };
    });
    if (result.isNew) {
      emitToMess(access.messId, "message:created", result.response.message);
      void deliverMessagePushes({
        recipientUserIds: result.pushRecipientUserIds,
        messId: access.messId,
        messageId: result.response.message.id,
        senderName: result.response.message.senderName,
        body,
      });
    }
    res.json(result.response);
  } catch (e) {
    const s = (e as any).status;
    if (s) {
      res.status(s).json({ error: (e as Error).message });
      return;
    }
    throw e;
  }
};
