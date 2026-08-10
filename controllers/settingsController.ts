import type { Response } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  messesTable,
  consumersTable,
  securityOtpsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { sendSecurityOtpEmail } from "../lib/email.js";
import { createOtpChallenge, normalizeEmail } from "../utils/authUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import {
  hashPassword,
  isPasswordValid,
  verifyPassword,
} from "../utils/passwordUtils.js";
import { resolvePrimaryAdminAccess } from "../utils/primaryAdminAccessUtils.js";
import {
  clearSecurityOtp,
  getLinkedConsumer,
  isSecurityAction,
  parseAdminActionPayload,
  toAdminActionPayload,
  verifyPendingSecurityOtp,
  type SecurityAction,
} from "../utils/securityOtpUtils.js";

// POST /api/settings/security/request-otp
export const requestSecurityOtp = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { action, currentPassword, payload } = req.body ?? {};

  if (!isSecurityAction(action)) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const act: SecurityAction = action;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (act === "change_password") {
    if (!currentPassword) {
      res.status(400).json({ error: "Current password is required" });
      return;
    }
    const valid = await verifyPassword(
      currentPassword as string,
      user.passwordHash,
    );
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
  }

  if (act === "update_email") {
    if (!payload) {
      res.status(400).json({ error: "New email is required" });
      return;
    }
    const newEmail = normalizeEmail(payload as string);
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, newEmail))
      .limit(1);
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: "This email address is already in use" });
      return;
    }
  }

  let storedPayload: string | null = payload ? String(payload) : null;

  if (act === "add_admin" || act === "add_co_admin") {
    const { messId: messIdParam } = req.body ?? {};
    const access = await resolvePrimaryAdminAccess(userId, messIdParam, {
      accessDeniedError: "Only the primary admin can perform this action",
    });
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const { messId, mess } = access;
    if (!payload) {
      res.status(400).json({ error: "Consumer ID is required" });
      return;
    }
    const consumerId = parsePositiveInteger(payload);
    const [consumer] = consumerId
      ? await db
          .select()
          .from(consumersTable)
          .where(
            and(
              eq(consumersTable.id, consumerId),
              eq(consumersTable.messId, mess.id),
            ),
          )
          .limit(1)
      : [];
    if (!consumer || !consumer.userId) {
      res
        .status(400)
        .json({ error: "Selected member does not have a linked account" });
      return;
    }
    if (consumer.userId === userId) {
      res.status(400).json({ error: "You are already the admin" });
      return;
    }
    if (act === "add_co_admin" && consumer.isAdmin) {
      res.status(400).json({ error: "This member is already an admin" });
      return;
    }
    storedPayload = toAdminActionPayload(messId, consumer.id);
  }

  const { otp, expiresAt } = createOtpChallenge();

  await clearSecurityOtp(userId, act);
  await db.insert(securityOtpsTable).values({
    userId,
    action: act,
    otp,
    payload: storedPayload,
    expiresAt,
  });

  try {
    await sendSecurityOtpEmail(user.email, user.name, act, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to send security OTP email");
    res
      .status(500)
      .json({ error: "Failed to send verification code. Please try again." });
    return;
  }

  res.json({ message: "Verification code sent" });
};

// POST /api/settings/security/change-password
export const changePassword = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp, newPassword } = req.body ?? {};

  if (!otp || !newPassword) {
    res.status(400).json({ error: "otp and newPassword are required" });
    return;
  }
  if (!isPasswordValid(newPassword as string)) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  const result = await verifyPendingSecurityOtp(
    userId,
    "change_password",
    otp as string,
  );
  if (result.error) {
    res.status(result.expired ? 410 : 401).json({ error: result.error });
    return;
  }

  const passwordHash = await hashPassword(newPassword as string);
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, userId));
  await clearSecurityOtp(userId, "change_password");

  res.json({ message: "Password changed successfully" });
};

// POST /api/settings/security/update-email
export const updateEmail = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }

  const result = await verifyPendingSecurityOtp(
    userId,
    "update_email",
    otp as string,
  );
  if (result.error) {
    res.status(result.expired ? 410 : 401).json({ error: result.error });
    return;
  }

  const newEmail = normalizeEmail(result.pending!.payload!);
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, newEmail))
    .limit(1);
  if (existing && existing.id !== userId) {
    await clearSecurityOtp(userId, "update_email");
    res.status(409).json({ error: "This email address is already in use" });
    return;
  }

  await db
    .update(usersTable)
    .set({ email: newEmail })
    .where(eq(usersTable.id, userId));
  await clearSecurityOtp(userId, "update_email");

  res.json({ message: "Email updated successfully", newEmail });
};

// POST /api/settings/security/add-admin
export const transferAdmin = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }

  const result = await verifyPendingSecurityOtp(
    userId,
    "add_admin",
    otp as string,
  );
  if (result.error) {
    res.status(result.expired ? 410 : 401).json({ error: result.error });
    return;
  }

  const { messId, consumerId } = parseAdminActionPayload(
    result.pending!.payload!,
  );
  const consumer = await getLinkedConsumer(consumerId);
  if (!consumer) {
    res.status(400).json({ error: "Consumer no longer has a linked account" });
    return;
  }
  if (!messId) {
    res.status(403).json({ error: "You are no longer the admin of this mess" });
    return;
  }

  const access = await resolvePrimaryAdminAccess(userId, messId, {
    accessDeniedError: "You are no longer the admin of this mess",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

  await db
    .update(messesTable)
    .set({ adminUserId: consumer.userId })
    .where(eq(messesTable.id, mess.id));
  await clearSecurityOtp(userId, "add_admin");

  res.json({ message: "Admin role transferred successfully" });
};

// POST /api/settings/security/add-co-admin — grant admin to a member without revoking current admin
export const addCoAdmin = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }

  const result = await verifyPendingSecurityOtp(
    userId,
    "add_co_admin",
    otp as string,
  );
  if (result.error) {
    res.status(result.expired ? 410 : 401).json({ error: result.error });
    return;
  }

  const { messId, consumerId } = parseAdminActionPayload(
    result.pending!.payload!,
  );
  const consumer = await getLinkedConsumer(consumerId);
  if (!consumer) {
    res.status(400).json({ error: "Consumer no longer has a linked account" });
    return;
  }
  if (!messId) {
    res
      .status(403)
      .json({ error: "You are no longer the primary admin of this mess" });
    return;
  }

  const access = await resolvePrimaryAdminAccess(userId, messId, {
    accessDeniedError: "You are no longer the primary admin of this mess",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  await db
    .update(consumersTable)
    .set({ isAdmin: true })
    .where(eq(consumersTable.id, consumer.id));
  await clearSecurityOtp(userId, "add_co_admin");

  res.json({ message: "Admin privileges granted successfully" });
};

// GET /api/settings/security/eligible-admins?messId=X
export const getEligibleAdmins = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolvePrimaryAdminAccess(userId, req.query.messId, {
    missingMessIdError: "messId query param is required",
    accessDeniedError: "Only the primary admin can view this",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

  const consumers = await db
    .select({
      id: consumersTable.id,
      name: consumersTable.name,
      userId: consumersTable.userId,
      isAdmin: consumersTable.isAdmin,
    })
    .from(consumersTable)
    .where(eq(consumersTable.messId, mess.id));

  const eligible = consumers.filter(
    (c) => c.userId !== null && c.userId !== userId,
  );
  res.json({ consumers: eligible });
};

// PATCH /api/settings/profile — update display name
export const updateProfile = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { name } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const normalizedName = (name as string).trim();
  if (normalizedName.length > 100) {
    res.status(400).json({ error: "Name is too long" });
    return;
  }
  await db
    .update(usersTable)
    .set({ name: normalizedName })
    .where(eq(usersTable.id, userId));
  res.json({ name: normalizedName });
};

// PATCH /api/settings/profile/phone — update mobile number
export const updatePhone = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { phone } = req.body ?? {};
  const trimmed = phone != null ? (phone as string).trim() : null;
  if (trimmed && trimmed.length > 20) {
    res.status(400).json({ error: "Phone number is too long" });
    return;
  }
  await db
    .update(usersTable)
    .set({ mobileNumber: trimmed || null })
    .where(eq(usersTable.id, userId));
  res.json({ mobileNumber: trimmed || null });
};

// PATCH /api/settings/mess — update mess name (admin only)
export const updateMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { name, messId: messIdParam } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Mess name is required" });
    return;
  }
  const normalizedName = (name as string).trim();
  if (normalizedName.length > 100) {
    res.status(400).json({ error: "Mess name is too long" });
    return;
  }
  const access = await resolvePrimaryAdminAccess(userId, messIdParam, {
    accessDeniedError: "Only the primary admin can update the mess name",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  await db
    .update(messesTable)
    .set({ name: normalizedName })
    .where(eq(messesTable.id, mess.id));
  res.json({ name: normalizedName });
};
