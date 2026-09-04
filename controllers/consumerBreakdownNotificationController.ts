import type { Response } from "express";
import { and, count, eq, isNull, sql } from "drizzle-orm";

import {
  consumerBreakdownNotificationsTable,
  consumersTable,
  db,
} from "../db/dbConfig.js";
import { deliverConsumerBreakdownPushes } from "../lib/notificationDelivery.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";

export const sendConsumerBreakdownNotification = async (
  req: AuthedRequest,
  res: Response,
) => {
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const recipients = await db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, access.messId),
          isNull(consumersTable.accountDeletedAt),
          sql`${consumersTable.userId} is not null`,
        ),
      );
    const userIds = [...new Set(members.flatMap(({ userId }) => (userId == null ? [] : [userId])))];
    if (userIds.length === 0) return [];
    return tx
      .insert(consumerBreakdownNotificationsTable)
      .values(userIds.map((userId) => ({ messId: access.messId, userId })))
      .returning({ userId: consumerBreakdownNotificationsTable.userId });
  });

  if (recipients.length === 0) {
    res.status(400).json({ error: "No active members with an app account" });
    return;
  }
  void deliverConsumerBreakdownPushes({
    recipientUserIds: recipients.map(({ userId }) => userId),
    messId: access.messId,
  });
  res.json({ notifiedCount: recipients.length });
};

export const getUnreadConsumerBreakdownCount = async (
  req: AuthedRequest,
  res: Response,
) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const [result] = await db
    .select({ total: count() })
    .from(consumerBreakdownNotificationsTable)
    .where(and(eq(consumerBreakdownNotificationsTable.messId, access.messId), eq(consumerBreakdownNotificationsTable.userId, req.auth!.userId), isNull(consumerBreakdownNotificationsTable.readAt)));
  res.json({ unreadCount: Number(result?.total ?? 0) });
};

export const markConsumerBreakdownNotificationsRead = async (
  req: AuthedRequest,
  res: Response,
) => {
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  await db
    .update(consumerBreakdownNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(consumerBreakdownNotificationsTable.messId, access.messId), eq(consumerBreakdownNotificationsTable.userId, req.auth!.userId), isNull(consumerBreakdownNotificationsTable.readAt)));
  res.json({ unreadCount: 0 });
};
