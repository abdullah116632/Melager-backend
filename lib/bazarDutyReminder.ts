import { and, eq, isNull } from "drizzle-orm";

import {
  db,
  bazarAssignmentNotificationsTable,
  bazarAssignmentsTable,
  bazarDutyRemindersTable,
  consumersTable,
} from "../db/dbConfig.js";
import { logger } from "./logger.js";
import { deliverBazarDutyReminderPushes } from "./notificationDelivery.js";
import { bazarWeekdayFromDate } from "../utils/bazarDateUtils.js";

const DHAKA_TIME_ZONE = "Asia/Dhaka";

const DHAKA_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DHAKA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface DhakaClock {
  /** `YYYY-MM-DD` in Dhaka. */
  date: string;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The wall clock in Dhaka, wherever the server itself happens to be.
 *
 * The mess keeps its books on Bangladesh time and the hosting timezone is not
 * ours to rely on, so every date in this module is derived here rather than
 * from the process's own locale.
 */
export const getDhakaClock = (now = new Date()): DhakaClock => {
  const parts = Object.fromEntries(
    DHAKA_PARTS_FORMATTER.formatToParts(now).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    second: Number(parts["second"]),
  };
};

/** The calendar day after `date`, both as `YYYY-MM-DD`. */
export const nextCalendarDate = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return next.toISOString().slice(0, 10);
};

interface ReminderRecipient {
  messId: number;
  userId: number;
}

/**
 * Sends every member on bazar duty tomorrow a push, once.
 *
 * Reminders are claimed in `bazar_duty_reminders` before anything is sent: the
 * unique constraint there is what makes a second run — a restart just after
 * 10pm, say — a no-op rather than a duplicate notification. A row only lands in
 * `bazar_assignment_notifications` (the Bazar List badge) for recipients whose
 * claim succeeded, so the badge count cannot drift either.
 *
 * Returns how many members were notified, for the log.
 */
export const sendTomorrowBazarDutyReminders = async (
  now = new Date(),
): Promise<number> => {
  const bazarDate = nextCalendarDate(getDhakaClock(now).date);
  const weekday = bazarWeekdayFromDate(bazarDate);

  const assignments = await db
    .select({
      messId: bazarAssignmentsTable.messId,
      userId: consumersTable.userId,
    })
    .from(bazarAssignmentsTable)
    .innerJoin(
      consumersTable,
      eq(bazarAssignmentsTable.consumerId, consumersTable.id),
    )
    .where(
      and(
        eq(bazarAssignmentsTable.weekday, weekday),
        // A member who deleted their account keeps their history but has no
        // device to notify.
        isNull(consumersTable.accountDeletedAt),
      ),
    );

  // One push per member per mess, even if they hold several assignment rows.
  const recipients = new Map<string, ReminderRecipient>();
  for (const { messId, userId } of assignments) {
    if (userId == null) continue;
    recipients.set(`${messId}:${userId}`, { messId, userId });
  }
  if (recipients.size === 0) return 0;

  const claimed = await db
    .insert(bazarDutyRemindersTable)
    .values(
      [...recipients.values()].map(({ messId, userId }) => ({
        messId,
        userId,
        bazarDate,
      })),
    )
    .onConflictDoNothing()
    .returning({
      messId: bazarDutyRemindersTable.messId,
      userId: bazarDutyRemindersTable.userId,
    });
  if (claimed.length === 0) return 0;

  await db.insert(bazarAssignmentNotificationsTable).values(
    claimed.map(({ messId, userId }) => ({
      messId,
      userId,
      bazarDate,
    })),
  );

  // Grouped by mess because the payload carries the mess the duty belongs to.
  const byMess = new Map<number, number[]>();
  for (const { messId, userId } of claimed) {
    byMess.set(messId, [...(byMess.get(messId) ?? []), userId]);
  }
  for (const [messId, recipientUserIds] of byMess) {
    await deliverBazarDutyReminderPushes({
      recipientUserIds,
      messId,
      bazarDate,
    });
  }

  logger.info(
    { bazarDate, weekday, notified: claimed.length },
    "Sent bazar duty reminders",
  );
  return claimed.length;
};
