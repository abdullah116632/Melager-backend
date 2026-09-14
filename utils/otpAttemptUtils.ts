import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "../db/dbConfig.js";

/**
 * Wrong guesses a single OTP challenge tolerates before it is destroyed. A
 * six-digit code only resists brute force because of this limit: without it,
 * the whole 000000-999999 space fits comfortably inside the ten-minute window.
 */
export const MAX_OTP_ATTEMPTS = 5;

export const OTP_ATTEMPTS_EXHAUSTED_ERROR =
  "Too many incorrect attempts. Please request a new code.";

/** Seconds a caller must wait before a fresh code is sent to the same target. */
export const OTP_REQUEST_COOLDOWN_MS = 60_000;

export const OTP_COOLDOWN_ERROR =
  "Please wait 60 seconds before requesting another code";

type OtpChallengeTable = PgTable & { attempts: PgColumn };

/**
 * Records one wrong guess and reports whether the challenge is now burned.
 *
 * The increment and the read happen in one statement so that guesses arriving
 * in parallel cannot each observe the same pre-increment count and slip past
 * the limit together. An exhausted challenge is deleted rather than left to
 * expire, so the caller must go back through the email round trip.
 */
export const registerFailedOtpAttempt = async (
  table: OtpChallengeTable,
  where: SQL,
): Promise<{ exhausted: boolean }> => {
  const [row] = await db
    .update(table)
    .set({ attempts: sql`${table.attempts} + 1` })
    .where(where)
    .returning({ attempts: table.attempts });

  // A missing row means the challenge was cleared concurrently; treat that the
  // same as exhausted so no branch can keep guessing against nothing.
  const exhausted =
    Number(row?.attempts ?? MAX_OTP_ATTEMPTS) >= MAX_OTP_ATTEMPTS;
  if (exhausted) await db.delete(table).where(where);
  return { exhausted };
};

/** True while the previous code for this target is still inside its cooldown. */
export const isWithinOtpCooldown = (createdAt: Date | null | undefined) =>
  createdAt != null &&
  Date.now() - createdAt.getTime() < OTP_REQUEST_COOLDOWN_MS;
