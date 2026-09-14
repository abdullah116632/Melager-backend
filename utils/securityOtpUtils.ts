import { and, eq } from "drizzle-orm";
import { consumersTable, db, securityOtpsTable } from "../db/dbConfig.js";
import { isOtpExpired, otpMatches } from "./authUtils.js";
import {
  OTP_ATTEMPTS_EXHAUSTED_ERROR,
  registerFailedOtpAttempt,
} from "./otpAttemptUtils.js";
import { parsePositiveInteger } from "./numberUtils.js";

export const SECURITY_ACTIONS = [
  "update_email",
  "add_admin",
  "add_co_admin",
  "remove_self_admin",
] as const;

export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export const isSecurityAction = (value: unknown): value is SecurityAction =>
  SECURITY_ACTIONS.includes(value as SecurityAction);

export const clearSecurityOtp = async (
  userId: number,
  action: SecurityAction,
) => {
  await db
    .delete(securityOtpsTable)
    .where(
      and(
        eq(securityOtpsTable.userId, userId),
        eq(securityOtpsTable.action, action),
      ),
    );
};

/**
 * Checks one security OTP and reports the HTTP status a caller should answer
 * with. `status` is authoritative: a burned challenge answers 429, an expired
 * one 410, anything else wrong 401.
 */
export const verifyPendingSecurityOtp = async (
  userId: number,
  action: SecurityAction,
  otpInput: string,
) => {
  const challengeMatches = and(
    eq(securityOtpsTable.userId, userId),
    eq(securityOtpsTable.action, action),
  )!;
  const [pending] = await db
    .select()
    .from(securityOtpsTable)
    .where(challengeMatches)
    .limit(1);

  if (!pending) {
    return {
      error: "No pending verification. Please request a new code.",
      status: 401 as const,
    };
  }
  if (isOtpExpired(pending.expiresAt)) {
    return {
      error: "Code expired. Please request a new one.",
      status: 410 as const,
    };
  }
  if (!otpMatches(pending.otp, otpInput)) {
    const { exhausted } = await registerFailedOtpAttempt(
      securityOtpsTable,
      challengeMatches,
    );
    return exhausted
      ? { error: OTP_ATTEMPTS_EXHAUSTED_ERROR, status: 429 as const }
      : { error: "Incorrect code. Please try again.", status: 401 as const };
  }

  return { pending };
};

export const toAdminActionPayload = (
  messId: number,
  consumerId: number,
): string => `${messId}:${consumerId}`;

export const parseAdminActionPayload = (
  payload: string,
): { messId: number; consumerId: number | null } => {
  const separatorIndex = payload.indexOf(":");
  return {
    messId:
      separatorIndex === -1
        ? 0
        : (parsePositiveInteger(payload.substring(0, separatorIndex)) ?? 0),
    consumerId: parsePositiveInteger(
      separatorIndex === -1 ? payload : payload.substring(separatorIndex + 1),
    ),
  };
};

export const getLinkedConsumer = async (consumerId: number | null) => {
  if (!consumerId) return null;

  const [consumer] = await db
    .select()
    .from(consumersTable)
    .where(eq(consumersTable.id, consumerId))
    .limit(1);

  if (!consumer?.userId) return null;
  return { ...consumer, userId: consumer.userId };
};
