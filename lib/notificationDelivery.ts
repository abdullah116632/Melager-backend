import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  db,
  messesTable,
  notificationsTable,
  pushTokensTable,
  usersTable,
  type Notification,
} from "../db/dbConfig.js";
import { logger } from "./logger.js";
import { emitToUser } from "../realtime/socket.js";
import {
  BAZAR_WEEKDAY_NAMES,
  bazarWeekdayFromDate,
} from "../utils/bazarDateUtils.js";

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

// Notifications that must open Mess Hub, outside every mess. Their push data
// leaves messId out: an app that sees one switches into that mess first.
const isMessHubNotification = (type: string): boolean =>
  type === "manager_role_transferred" || type === "manager_role_added";

const notificationRoute = (type: string): string =>
  isMessHubNotification(type)
    ? "/"
    : type === "member_request"
    ? "/member-requests"
    : type === "member_request_accepted"
      ? "/"
      : type === "meal_opt_out"
        ? "/meal-status"
        : type === "notice"
          ? "/notice-board"
          : type === "message"
            ? "/messages"
            : type === "menu"
              ? "/meal-status"
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
        ...(isMessHubNotification(notification.type)
          ? {}
          : { messId: notification.messId }),
        noticeId: notification.noticeId,
        type: notification.type,
        route: notificationRoute(notification.type),
      },
    })),
  );
};

/**
 * Tells a member they now manage a mess, either because the role was handed
 * to them or because they were added as another manager. It is saved to that
 * mess's notification list and pushed to the member's devices; the push opens
 * Mess Hub (see isMessHubNotification). Best-effort and never throws: the role
 * change has already been saved.
 */
export const deliverManagerRolePush = async ({
  messId,
  recipientUserId,
  actorUserId,
  kind,
}: {
  messId: number;
  recipientUserId: number;
  actorUserId: number;
  kind: "transferred" | "added";
}): Promise<void> => {
  try {
    const [[mess], [actor]] = await Promise.all([
      db
        .select({ name: messesTable.name })
        .from(messesTable)
        .where(eq(messesTable.id, messId))
        .limit(1),
      db
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, actorUserId))
        .limit(1),
    ]);
    const messName = mess?.name ?? "your mess";
    const actorName = actor?.name ?? "A manager";
    const [notification] = await db
      .insert(notificationsTable)
      .values({
        messId,
        userId: recipientUserId,
        type: `manager_role_${kind}`,
        title:
          kind === "transferred"
            ? "You are now the manager"
            : "You are now a manager",
        body:
          kind === "transferred"
            ? `${actorName} handed the manager role of ${messName} to you.`
            : `${actorName} made you a manager of ${messName}.`,
      })
      .returning();
    if (notification) await deliverNotifications([notification]);
  } catch (err) {
    logger.warn({ err }, "Could not deliver manager role notification");
  }
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

/** Sends Bazar-duty pushes and updates only the Bazar List unread badge. */
export const deliverBazarAssignmentPushes = async ({
  recipientUserIds,
  messId,
  bazarDate,
}: {
  recipientUserIds: number[];
  messId: number;
  bazarDate: string;
}): Promise<void> => {
  const weekdayName =
    BAZAR_WEEKDAY_NAMES[bazarWeekdayFromDate(bazarDate)] ?? "the selected day";

  recipientUserIds.forEach((userId) => {
    emitToUser(userId, "bazar-assignment:created", { messId });
  });

  await deliverPushes(
    recipientUserIds.map((userId) => ({
      userId,
      title: "Bazar duty assigned",
      body: `You have been assigned for ${weekdayName} (${bazarDate}) bazar.`,
      channelId: "default",
      data: {
        messId,
        type: "bazar_assignment",
        route: "/bazar-list",
      },
    })),
  );
};

/**
 * The night-before reminder for tomorrow's bazar duty.
 *
 * It carries the same `type` and `route` as the manual assignment push, so app
 * versions already in the field route it to the Bazar List without needing an
 * update; only the wording differs.
 */
export const deliverBazarDutyReminderPushes = async ({
  recipientUserIds,
  messId,
  bazarDate,
}: {
  recipientUserIds: number[];
  messId: number;
  bazarDate: string;
}): Promise<void> => {
  const weekdayName =
    BAZAR_WEEKDAY_NAMES[bazarWeekdayFromDate(bazarDate)] ?? "tomorrow";

  recipientUserIds.forEach((userId) => {
    emitToUser(userId, "bazar-assignment:created", { messId });
  });

  await deliverPushes(
    recipientUserIds.map((userId) => ({
      userId,
      title: "Tomorrow is your bazar day",
      body: `You are on bazar duty tomorrow, ${weekdayName} (${bazarDate}).`,
      channelId: "default",
      data: {
        messId,
        type: "bazar_assignment",
        route: "/bazar-list",
      },
    })),
  );
};

/** Sends Consumer Breakdown pushes without adding entries to the bell. */
export const deliverConsumerBreakdownPushes = async ({
  recipientUserIds,
  messId,
}: {
  recipientUserIds: number[];
  messId: number;
}): Promise<void> => {
  recipientUserIds.forEach((userId) => {
    emitToUser(userId, "consumer-breakdown:created", { messId });
  });

  await deliverPushes(
    recipientUserIds.map((userId) => ({
      userId,
      title: "Consumer Breakdown updated",
      body: "Open Consumer Breakdown to check the latest summary.",
      channelId: "default",
      data: {
        messId,
        type: "consumer_breakdown",
        route: "/consumer-breakdown",
      },
    })),
  );
};
