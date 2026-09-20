import {
  getDhakaClock,
  sendTomorrowBazarDutyReminders,
} from "./bazarDutyReminder.js";
import { logger } from "./logger.js";

/** Reminders go out at 10pm Bangladesh time, the night before the duty. */
export const REMINDER_HOUR = 22;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Land a little past the hour so a slow clock cannot fire at 21:59:59. */
const SETTLE_MS = 2_000;

/**
 * Milliseconds from `now` until the next 10pm in Dhaka.
 *
 * Derived from the Dhaka wall clock rather than from a fixed UTC offset, so the
 * job stays correct whatever timezone the host is configured for.
 */
export const msUntilNextReminder = (now = new Date()): number => {
  const { hour, minute, second } = getDhakaClock(now);
  const secondsNow = hour * 3600 + minute * 60 + second;
  const secondsTarget = REMINDER_HOUR * 3600;
  const secondsAway =
    secondsTarget > secondsNow
      ? secondsTarget - secondsNow
      : secondsTarget - secondsNow + 24 * 60 * 60;
  return secondsAway * 1000 + SETTLE_MS;
};

let timer: ReturnType<typeof setTimeout> | null = null;

const runOnce = async (reason: string): Promise<void> => {
  try {
    await sendTomorrowBazarDutyReminders();
  } catch (err) {
    // A failed run must never take the API down with it; the next evening's
    // run is unaffected, and the reminder table keeps a repeat harmless.
    logger.error({ err, reason }, "Bazar duty reminder run failed");
  }
};

const scheduleNext = (): void => {
  const delay = msUntilNextReminder();
  timer = setTimeout(() => {
    void runOnce("scheduled").finally(scheduleNext);
  }, delay);
  // Nothing here should hold the process open on its own.
  timer.unref?.();
  logger.info(
    { minutesAway: Math.round(delay / 60_000) },
    "Bazar duty reminder scheduled",
  );
};

/**
 * Starts the nightly reminder timer. Safe to call once at boot.
 *
 * If the process comes up after 10pm Dhaka — a deploy or a restart during the
 * evening — the run is attempted straight away rather than skipped until the
 * next night. That is only safe because the reminder table makes a repeat a
 * no-op, so a restart cannot notify anyone twice.
 */
export const startBazarDutyReminderScheduler = (): void => {
  if (timer) return;
  const { hour } = getDhakaClock();
  if (hour >= REMINDER_HOUR) {
    void runOnce("startup-catch-up");
  }
  scheduleNext();
};

export const stopBazarDutyReminderScheduler = (): void => {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
};
