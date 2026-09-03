import { inArray } from "drizzle-orm";

import { db, pushTokensTable, type Notification } from "../db/dbConfig.js";
import { logger } from "./logger.js";
import { emitToUser } from "../realtime/socket.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const notificationRoute = (type: string): string =>
  type === "notice"
    ? "/notice-board"
    : type === "message"
      ? "/messages"
      : "/bazar-list";

/**
 * Call only after a notification row has committed. It fans out to open app
 * sessions immediately and sends OS-level pushes to registered devices.
 */
export const deliverNotifications = async (
  notifications: Notification[],
): Promise<void> => {
  if (notifications.length === 0) return;

  notifications.forEach((notification) => {
    emitToUser(notification.userId, "notification:created", notification);
  });

  try {
    const userIds = [...new Set(notifications.map(({ userId }) => userId))];
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
    const messages = notifications.flatMap((notification) =>
      (byUser.get(notification.userId) ?? []).map((to) => ({
        to,
        title: notification.title,
        body: notification.body,
        sound: "default",
        priority: "high",
        channelId: "default",
        data: {
          notificationId: notification.id,
          messId: notification.messId,
          noticeId: notification.noticeId,
          type: notification.type,
          route: notificationRoute(notification.type),
        },
      })),
    );
    for (let start = 0; start < messages.length; start += 100) {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messages.slice(start, start + 100)),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "Expo push request failed");
      }
    }
  } catch (err) {
    // A push outage must never undo a notification that has already been saved.
    logger.warn({ err }, "Could not deliver push notifications");
  }
};
