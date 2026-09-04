import { and, count, inArray, isNull, sql } from "drizzle-orm";

import {
  db,
  notificationsTable,
  pushTokensTable,
  type Notification,
} from "../db/dbConfig.js";
import { logger } from "./logger.js";
import { emitToUser } from "../realtime/socket.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

type ExpoPushResponse = { data?: ExpoPushTicket[] };

type PushDelivery = {
  userId: number;
  title: string;
  body: string;
  channelId: string;
  badge?: number;
  data: Record<string, unknown>;
};

const notificationRoute = (type: string): string =>
  type === "notice"
    ? "/notice-board"
    : type === "message"
      ? "/messages"
      : "/bazar-list";

const deliverPushes = async (deliveries: PushDelivery[]): Promise<void> => {
  if (deliveries.length === 0) return;
  try {
    const userIds = [...new Set(deliveries.map(({ userId }) => userId))];
    const devices = await db
      .select({ userId: pushTokensTable.userId, token: pushTokensTable.token })
      .from(pushTokensTable)
      .where(inArray(pushTokensTable.userId, userIds));
    if (devices.length === 0) return;

    const byUser = new Map<number, string[]>();
    devices.forEach(({ userId, token }) => {
      const tokens = byUser.get(userId) ?? [];
      tokens.push(token);
      byUser.set(userId, tokens);
    });
    const messages = deliveries.flatMap((delivery) =>
      (byUser.get(delivery.userId) ?? []).map((to) => ({
        to,
        title: delivery.title,
        body: delivery.body,
        sound: "default",
        priority: "high",
        channelId: delivery.channelId,
        ...(delivery.badge === undefined ? {} : { badge: delivery.badge }),
        ttl: 86_400,
        data: delivery.data,
      })),
    );
    const invalidTokens = new Set<string>();
    for (let start = 0; start < messages.length; start += 100) {
      const batch = messages.slice(start, start + 100);
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "Expo push request failed");
        continue;
      }

      const result = (await response.json()) as ExpoPushResponse;
      result.data?.forEach((ticket, index) => {
        if (ticket.status !== "error") return;
        const token = batch[index]?.to;
        if (ticket.details?.error === "DeviceNotRegistered" && token) {
          invalidTokens.add(token);
          return;
        }
        logger.warn(
          {
            error: ticket.details?.error,
            message: ticket.message,
          },
          "Expo rejected a push notification",
        );
      });
    }

    if (invalidTokens.size > 0) {
      await db
        .delete(pushTokensTable)
        .where(inArray(pushTokensTable.token, [...invalidTokens]));
      logger.info(
        { count: invalidTokens.size },
        "Removed expired push notification tokens",
      );
    }
  } catch (err) {
    // Push delivery is best-effort and must not make a saved action fail.
    logger.warn({ err }, "Could not deliver push notifications");
  }
};

/**
 * Call only after notification rows commit. Open apps receive a socket event;
 * background devices receive an OS-level push.
 */
export const deliverNotifications = async (
  notifications: Notification[],
): Promise<void> => {
  if (notifications.length === 0) return;

  notifications.forEach((notification) => {
    emitToUser(notification.userId, "notification:created", notification);
  });

  const userIds = [...new Set(notifications.map(({ userId }) => userId))];
  let unreadByUser = new Map<number, number>();
  try {
    const unreadRows = await db
      .select({ userId: notificationsTable.userId, total: count() })
      .from(notificationsTable)
      .where(
        and(
          inArray(notificationsTable.userId, userIds),
          isNull(notificationsTable.readAt),
          sql`${notificationsTable.type} NOT IN ('message', 'notice')`,
        ),
      )
      .groupBy(notificationsTable.userId);
    unreadByUser = new Map(
      unreadRows.map(({ userId, total }) => [userId, Number(total)]),
    );
  } catch (err) {
    logger.warn({ err }, "Could not calculate notification badge counts");
  }

  await deliverPushes(
    notifications.map((notification) => ({
      userId: notification.userId,
      title: notification.title,
      body: notification.body,
      channelId: "default",
      badge: unreadByUser.get(notification.userId) ?? 1,
      data: {
        notificationId: notification.id,
        messId: notification.messId,
        noticeId: notification.noticeId,
        type: notification.type,
        route: notificationRoute(notification.type),
      },
    })),
  );
};

/** Sends chat pushes without creating rows in the general notifications table. */
export const deliverMessagePushes = async ({
  recipientUserIds,
  messId,
  messageId,
  senderName,
  body,
}: {
  recipientUserIds: number[];
  messId: number;
  messageId: number;
  senderName: string;
  body: string;
}): Promise<void> =>
  deliverPushes(
    recipientUserIds.map((userId) => ({
      userId,
      title: `New message from ${senderName}`,
      body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
      channelId: "messages",
      data: {
        messageId,
        messId,
        type: "message",
        route: "/messages",
      },
    })),
  );

/** Sends notice pushes without creating rows in the general notifications table. */
export const deliverNoticePushes = async ({
  recipientUserIds,
  messId,
  noticeId,
  title,
  body,
}: {
  recipientUserIds: number[];
  messId: number;
  noticeId: number;
  title: string;
  body: string;
}): Promise<void> =>
  deliverPushes(
    recipientUserIds.map((userId) => ({
      userId,
      title: `New notice: ${title}`,
      body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
      channelId: "notices",
      data: {
        noticeId,
        messId,
        type: "notice",
        route: "/notice-board",
      },
    })),
  );
