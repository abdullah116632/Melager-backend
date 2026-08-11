import { and, eq } from "drizzle-orm";
import { consumersTable, db, securityOtpsTable } from "../db/dbConfig.js";
import { isOtpExpired, normalizeOtp } from "./authUtils.js";
import { parsePositiveInteger } from "./numberUtils.js";

export const SECURITY_ACTIONS = [
  "change_password",
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

export const verifyPendingSecurityOtp = async (
  userId: number,
  action: SecurityAction,
  otpInput: string,
) => {
  const [pending] = await db
    .select()
    .from(securityOtpsTable)
    .where(
      and(
        eq(securityOtpsTable.userId, userId),
        eq(securityOtpsTable.action, action),
      ),
    )
    .limit(1);

  if (!pending) {
    return {
      error: "No pending verification. Please request a new code.",
      expired: false,
    };
  }
  if (isOtpExpired(pending.expiresAt)) {
    return { error: "Code expired. Please request a new one.", expired: true };
  }
  if (pending.otp !== normalizeOtp(otpInput)) {
    return { error: "Incorrect code. Please try again.", expired: false };
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
