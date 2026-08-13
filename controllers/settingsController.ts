import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";
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
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { deleteUserAccountPreservingAccounting } from "../utils/accountDeletionUtils.js";
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
  const { action, currentPassword, newPassword, payload } = req.body ?? {};

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

  let storedPayload: string | null = payload ? String(payload) : null;

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
    if (!isPasswordValid(String(newPassword ?? ""))) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }
    storedPayload = await hashPassword(newPassword as string);
  }

  if (act === "update_email") {
    if (!payload) {
      res.status(400).json({ error: "New email is required" });
      return;
    }
    const newEmail = normalizeEmail(payload as string);
    if (newEmail === normalizeEmail(user.email)) {
      res.status(400).json({
        error: "New email must be different from your current email",
      });
      return;
    }
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

  if (act === "remove_self_admin") {
    const { messId: messIdParam } = req.body ?? {};
    const access = await resolveMessAccess(userId, messIdParam, {
      adminOnly: true,
      missingMessIdError: "messId is required",
    });
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const adminConsumers = await db
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, access.mess.id),
          eq(consumersTable.isAdmin, true),
        ),
      );
    const adminUserIds = new Set<number>([access.mess.adminUserId]);
    for (const consumer of adminConsumers) {
      if (consumer.userId) adminUserIds.add(consumer.userId);
    }
    if (adminUserIds.size <= 1) {
      res.status(409).json({
        error:
          "You are the only admin. Add another admin before removing your role.",
      });
      return;
    }

    storedPayload = String(access.mess.id);
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

// POST /api/settings/security/resend-otp — resend an existing challenge
export const resendSecurityOtp = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { action } = req.body ?? {};

  if (!isSecurityAction(action)) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const act: SecurityAction = action;

  const [[user], [pending]] = await Promise.all([
    db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
    db
      .select({ id: securityOtpsTable.id })
      .from(securityOtpsTable)
      .where(
        and(
          eq(securityOtpsTable.userId, userId),
          eq(securityOtpsTable.action, act),
        ),
      )
      .limit(1),
  ]);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (!pending) {
    res.status(400).json({
      error: "No pending verification. Please start the request again.",
    });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();
  try {
    await sendSecurityOtpEmail(user.email, user.name, act, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to resend security OTP email");
    res
      .status(500)
      .json({ error: "Failed to resend verification code. Please try again." });
    return;
  }

  await db
    .update(securityOtpsTable)
    .set({ otp, expiresAt, createdAt: new Date() })
    .where(eq(securityOtpsTable.id, pending.id));

  res.json({ message: "Verification code resent" });
};

// POST /api/settings/security/change-password
export const changePassword = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp, newPassword } = req.body ?? {};

  if (!otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }
  if (newPassword && !isPasswordValid(newPassword as string)) {
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

  if (!result.pending!.payload && !newPassword) {
    res.status(400).json({ error: "Please start the password change again" });
    return;
  }

  const passwordHash = result.pending!.payload
    ? result.pending!.payload
    : await hashPassword(newPassword as string);
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
  const [[currentUser], [existing]] = await Promise.all([
    db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
    db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, newEmail))
      .limit(1),
  ]);
  if (!currentUser) {
    await clearSecurityOtp(userId, "update_email");
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (newEmail === normalizeEmail(currentUser.email)) {
    await clearSecurityOtp(userId, "update_email");
    res.status(400).json({
      error: "New email must be different from your current email",
    });
    return;
  }
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
  if (!messId || !consumerId) {
    res.status(403).json({ error: "You are no longer the admin of this mess" });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${messesTable.id} from ${messesTable} where ${messesTable.id} = ${messId} for update`,
    );

    const [mess] = await tx
      .select({ adminUserId: messesTable.adminUserId })
      .from(messesTable)
      .where(eq(messesTable.id, messId))
      .limit(1);
    if (!mess || mess.adminUserId !== userId) {
      return {
        error: "You are no longer the primary admin of this mess",
        status: 403,
      } as const;
    }

    const [currentAdminConsumer] = await tx
      .select({ id: consumersTable.id })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      )
      .limit(1);
    if (!currentAdminConsumer) {
      return {
        error: "Your linked consumer record could not be found",
        status: 409,
      } as const;
    }

    const [newAdmin] = await tx
      .select({
        id: consumersTable.id,
        userId: consumersTable.userId,
      })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.id, consumerId),
          eq(consumersTable.messId, messId),
        ),
      )
      .limit(1);
    if (!newAdmin?.userId) {
      return {
        error: "Selected member no longer has a linked account",
        status: 400,
      } as const;
    }
    if (newAdmin.userId === userId) {
      return { error: "You are already the admin", status: 400 } as const;
    }

    await tx
      .update(consumersTable)
      .set({ isAdmin: true })
      .where(eq(consumersTable.id, newAdmin.id));
    await tx
      .update(messesTable)
      .set({ adminUserId: newAdmin.userId })
      .where(eq(messesTable.id, messId));
    await tx
      .update(consumersTable)
      .set({ isAdmin: false })
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      );
    await tx
      .delete(securityOtpsTable)
      .where(
        and(
          eq(securityOtpsTable.userId, userId),
          eq(securityOtpsTable.action, "add_admin"),
        ),
      );

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

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

// POST /api/settings/security/remove-self-admin — revoke the caller's own admin role
export const removeSelfAdmin = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }

  const result = await verifyPendingSecurityOtp(
    userId,
    "remove_self_admin",
    otp as string,
  );
  if (result.error) {
    res.status(result.expired ? 410 : 401).json({ error: result.error });
    return;
  }

  const messId = parsePositiveInteger(result.pending!.payload);
  if (!messId) {
    await clearSecurityOtp(userId, "remove_self_admin");
    res.status(400).json({ error: "Invalid admin removal request" });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${messesTable.id} from ${messesTable} where ${messesTable.id} = ${messId} for update`,
    );

    const [mess] = await tx
      .select({
        id: messesTable.id,
        adminUserId: messesTable.adminUserId,
      })
      .from(messesTable)
      .where(eq(messesTable.id, messId))
      .limit(1);
    if (!mess) {
      return { error: "Mess not found", status: 404 } as const;
    }

    const [currentConsumer] = await tx
      .select({
        id: consumersTable.id,
        isAdmin: consumersTable.isAdmin,
      })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      )
      .limit(1);
    const isPrimaryAdmin = mess.adminUserId === userId;
    if (!isPrimaryAdmin && !currentConsumer?.isAdmin) {
      return {
        error: "You are no longer an admin of this mess",
        status: 403,
      } as const;
    }
    if (!currentConsumer) {
      return {
        error: "Your linked consumer record could not be found",
        status: 409,
      } as const;
    }

    const adminConsumers = await tx
      .select({
        id: consumersTable.id,
        userId: consumersTable.userId,
      })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.isAdmin, true),
        ),
      );
    const adminUserIds = new Set<number>([mess.adminUserId]);
    for (const consumer of adminConsumers) {
      if (consumer.userId) adminUserIds.add(consumer.userId);
    }
    if (adminUserIds.size <= 1) {
      return {
        error:
          "You are the only admin. Add another admin before removing your role.",
        status: 409,
      } as const;
    }

    if (isPrimaryAdmin) {
      const replacement = adminConsumers.find(
        (consumer) => consumer.userId && consumer.userId !== userId,
      );
      if (!replacement?.userId) {
        return {
          error:
            "Another active admin is required before you can remove your role.",
          status: 409,
        } as const;
      }
      await tx
        .update(messesTable)
        .set({ adminUserId: replacement.userId })
        .where(eq(messesTable.id, messId));
    }

    await tx
      .update(consumersTable)
      .set({ isAdmin: false })
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      );
    await tx
      .delete(securityOtpsTable)
      .where(
        and(
          eq(securityOtpsTable.userId, userId),
          eq(securityOtpsTable.action, "remove_self_admin"),
        ),
      );

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json({ message: "Your admin role was removed successfully" });
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
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
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

// DELETE /api/settings/account — permanently removes the login account while
// anonymizing linked consumer rows so historical accounting remains intact.
export const deleteAccount = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { password } = req.body ?? {};

  if (typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: "Password is required" });
    return;
  }
  if (password.length > 256) {
    res.status(400).json({ error: "Password is too long" });
    return;
  }

  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      passwordHash: usersTable.passwordHash,
      googleSubject: usersTable.googleSubject,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    res.status(401).json({
      error: user.googleSubject
        ? "Password is incorrect. If you created this account with Google, use Forgot Password to set a password first."
        : "Password is incorrect",
    });
    return;
  }

  const outcome = await deleteUserAccountPreservingAccounting(
    userId,
    user.email,
  );

  if (outcome.blockedMessNames.length > 0) {
    res.status(409).json({
      error: `Add another admin before deleting your account in: ${outcome.blockedMessNames.join(", ")}`,
      blockingMesses: outcome.blockedMessNames,
    });
    return;
  }

  res.json({ success: true });
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
