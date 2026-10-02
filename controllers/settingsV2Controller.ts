import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";

import {
  consumersTable,
  db,
  messesTable,
  securityOtpsTable,
  usersTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { sendNewEmailVerificationOtp } from "../lib/email.js";
import { deliverManagerRolePush } from "../lib/notificationDelivery.js";
import {
  createOtpChallenge,
  isValidEmail,
  normalizeEmail,
} from "../utils/authUtils.js";
import {
  OTP_COOLDOWN_ERROR,
  isWithinOtpCooldown,
} from "../utils/otpAttemptUtils.js";
import { clearSecurityOtp } from "../utils/securityOtpUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { verifyPassword } from "../utils/passwordUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import {
  GoogleIdTokenError,
  verifyGoogleIdToken,
} from "../utils/googleIdTokenUtils.js";

// v2 settings endpoints replace the emailed-OTP identity check used by the
// v1 admin-management endpoints with the same password/Google verification
// introduced for Delete Mess. These are new, additive endpoints — the v1
// endpoints in settingsController.ts keep serving the live app unchanged,
// and share no code with these so neither can regress the other.

const verifyCallerIdentity = async (
  userId: number,
  password: unknown,
  googleIdToken: unknown,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
  const hasPassword = typeof password === "string" && password.length > 0;
  const hasGoogleIdToken =
    typeof googleIdToken === "string" && googleIdToken.length > 0;

  if (!hasPassword && !hasGoogleIdToken) {
    return {
      ok: false,
      status: 400,
      error: "Password or Google verification is required",
    };
  }
  if (hasPassword && (password as string).length > 256) {
    return { ok: false, status: 400, error: "Password is too long" };
  }

  const [user] = await db
    .select({
      email: usersTable.email,
      passwordHash: usersTable.passwordHash,
      googleSubject: usersTable.googleSubject,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) return { ok: false, status: 404, error: "Account not found" };

  if (hasGoogleIdToken) {
    try {
      const { email: verifiedEmail } = await verifyGoogleIdToken(
        googleIdToken as string,
      );
      if (normalizeEmail(verifiedEmail) !== normalizeEmail(user.email)) {
        return {
          ok: false,
          status: 401,
          error: "That Google account doesn't match this account's email",
        };
      }
    } catch (err) {
      if (err instanceof GoogleIdTokenError) {
        return { ok: false, status: err.status, error: err.message };
      }
      throw err;
    }
  } else {
    const passwordMatches = await verifyPassword(
      password as string,
      user.passwordHash,
    );
    if (!passwordMatches) {
      return {
        ok: false,
        status: 401,
        error: user.googleSubject
          ? "Password is incorrect. If you created this account with Google, use Forgot Password or Verify with Google instead."
          : "Password is incorrect",
      };
    }
  }

  return { ok: true };
};

// GET /api/v2/settings/security/admins?messId=X — lists every current admin
// of the mess (primary admin and any co-admins), for the "View All Admins"
// screen. Open to any admin.
export const getMessAdminsV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId, mess } = access;

  const admins = await db
    .select({
      id: consumersTable.id,
      name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      userId: consumersTable.userId,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(
      and(eq(consumersTable.messId, messId), eq(consumersTable.isAdmin, true)),
    );

  res.json({
    admins: admins.map((admin) => ({
      ...admin,
      isPrimaryAdmin: admin.userId === mess.adminUserId,
    })),
  });
};

// GET /api/v2/settings/security/eligible-admins?messId=X — same listing as
// the v1 endpoint, but open to any admin (primary or co-admin), not just
// the primary admin.
export const getEligibleAdminsV2 = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumers = await db
    .select({
      id: consumersTable.id,
      name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      userId: consumersTable.userId,
      isAdmin: consumersTable.isAdmin,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, messId));

  const eligible = consumers.filter(
    (c) => c.userId !== null && c.userId !== userId,
  );
  res.json({ consumers: eligible });
};

// POST /api/v2/settings/security/add-co-admin — grants admin to a member,
// verified via password or Google instead of an emailed OTP code. Any admin
// (primary or co-admin) may grant admin to another member.
export const addCoAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const {
    password,
    googleIdToken,
    messId: messIdParam,
    consumerId: consumerIdParam,
  } = req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumerId = parsePositiveInteger(consumerIdParam);
  const [consumer] = consumerId
    ? await db
        .select()
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.id, consumerId),
            eq(consumersTable.messId, messId),
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
  if (consumer.isAdmin) {
    res.status(400).json({ error: "This member is already an admin" });
    return;
  }

  const identity = await verifyCallerIdentity(userId, password, googleIdToken);
  if (!identity.ok) {
    res.status(identity.status).json({ error: identity.error });
    return;
  }

  await db
    .update(consumersTable)
    .set({ isAdmin: true })
    .where(eq(consumersTable.id, consumer.id));

  res.json({ message: "Admin privileges granted successfully" });
  void deliverManagerRolePush({
    messId,
    recipientUserId: consumer.userId,
    actorUserId: userId,
    kind: "added",
  });
};

// POST /api/v2/settings/security/add-admin — hands the caller's own admin
// status to another member, verified via password or Google instead of an
// emailed OTP code. Any admin (primary or co-admin) may call this, but it
// only ever swaps the CALLER's own status: if the caller is the primary
// admin, the mess's primary-admin slot (messesTable.adminUserId) moves to
// the target too; a co-admin has no such slot to move, so only the two
// consumers' isAdmin flags swap.
export const transferAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const {
    password,
    googleIdToken,
    messId: messIdParam,
    consumerId: consumerIdParam,
  } = req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumerId = parsePositiveInteger(consumerIdParam);
  const [target] = consumerId
    ? await db
        .select()
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.id, consumerId),
            eq(consumersTable.messId, messId),
          ),
        )
        .limit(1)
    : [];
  if (!target || !target.userId) {
    res
      .status(400)
      .json({ error: "Selected member does not have a linked account" });
    return;
  }
  if (target.userId === userId) {
    res.status(400).json({ error: "You are already the admin" });
    return;
  }
  if (target.isAdmin) {
    res.status(400).json({ error: "This member is already an admin" });
    return;
  }

  const identity = await verifyCallerIdentity(userId, password, googleIdToken);
  if (!identity.ok) {
    res.status(identity.status).json({ error: identity.error });
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
    if (!mess) {
      return { error: "Mess not found", status: 404 } as const;
    }
    const isPrimaryAdmin = mess.adminUserId === userId;

    const [callerConsumer] = await tx
      .select({ id: consumersTable.id, isAdmin: consumersTable.isAdmin })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      )
      .limit(1);
    if (!callerConsumer) {
      return {
        error: "Your linked consumer record could not be found",
        status: 409,
      } as const;
    }
    if (!isPrimaryAdmin && !callerConsumer.isAdmin) {
      return { error: "Admin access required", status: 403 } as const;
    }

    const [newAdmin] = await tx
      .select({
        id: consumersTable.id,
        userId: consumersTable.userId,
        isAdmin: consumersTable.isAdmin,
      })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.id, target.id),
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
    if (newAdmin.isAdmin) {
      return {
        error: "This member is already an admin",
        status: 400,
      } as const;
    }

    await tx
      .update(consumersTable)
      .set({ isAdmin: true })
      .where(eq(consumersTable.id, newAdmin.id));
    if (isPrimaryAdmin) {
      await tx
        .update(messesTable)
        .set({ adminUserId: newAdmin.userId })
        .where(eq(messesTable.id, messId));
    }
    await tx
      .update(consumersTable)
      .set({ isAdmin: false })
      .where(eq(consumersTable.id, callerConsumer.id));

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json({ message: "Admin role transferred successfully" });
  void deliverManagerRolePush({
    messId,
    recipientUserId: target.userId,
    actorUserId: userId,
    kind: "transferred",
  });
};

// POST /api/v2/settings/security/remove-self-admin — revokes the caller's
// own admin role, verified via password or Google instead of an emailed OTP
// code. Any admin (primary or co-admin) may call this. A mess must always
// keep at least one admin: if the caller is the only admin, this is
// rejected; if the caller is the primary admin, another existing admin
// becomes the new primary admin.
export const removeSelfAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { password, googleIdToken, messId: messIdParam } = req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const identity = await verifyCallerIdentity(userId, password, googleIdToken);
  if (!identity.ok) {
    res.status(identity.status).json({ error: identity.error });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${messesTable.id} from ${messesTable} where ${messesTable.id} = ${messId} for update`,
    );

    const [mess] = await tx
      .select({ id: messesTable.id, adminUserId: messesTable.adminUserId })
      .from(messesTable)
      .where(eq(messesTable.id, messId))
      .limit(1);
    if (!mess) {
      return { error: "Mess not found", status: 404 } as const;
    }

    const [currentConsumer] = await tx
      .select({ id: consumersTable.id, isAdmin: consumersTable.isAdmin })
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
      .select({ id: consumersTable.id, userId: consumersTable.userId })
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
      .where(eq(consumersTable.id, currentConsumer.id));

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json({ message: "Your admin role was removed successfully" });
};

// POST /api/v2/settings/security/verify-identity — confirms the caller's
// password or Google account without doing anything else. The flows that
// follow verify again, so this only exists to report a wrong password before
// the user has filled in the rest of the form.
export const verifyIdentityV2 = async (req: AuthedRequest, res: Response) => {
  const identity = await verifyCallerIdentity(
    req.auth!.userId,
    req.body?.password,
    req.body?.googleIdToken,
  );
  if (!identity.ok) {
    res.status(identity.status).json({ error: identity.error });
    return;
  }
  res.json({ verified: true });
};

/** Rejects a new email the account cannot take, with the status to answer. */
const validateNewEmail = async (
  userId: number,
  rawEmail: unknown,
): Promise<
  { ok: true; newEmail: string } | { ok: false; status: number; error: string }
> => {
  if (!isValidEmail(rawEmail)) {
    return { ok: false, status: 400, error: "Enter a valid email address" };
  }
  const newEmail = normalizeEmail(rawEmail);
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
    return { ok: false, status: 404, error: "Account not found" };
  }
  if (newEmail === normalizeEmail(currentUser.email)) {
    return {
      ok: false,
      status: 400,
      error: "New email must be different from your current email",
    };
  }
  if (existing && existing.id !== userId) {
    return {
      ok: false,
      status: 409,
      error: "This email address is already in use",
    };
  }
  return { ok: true, newEmail };
};

// POST /api/v2/settings/security/request-email-change — password (or Google)
// proves who is asking, then the code goes to the address being claimed. The
// account keeps its current email until that code is confirmed through the
// existing POST /settings/security/update-email.
export const requestEmailChangeV2 = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const identity = await verifyCallerIdentity(
    userId,
    req.body?.password,
    req.body?.googleIdToken,
  );
  if (!identity.ok) {
    res.status(identity.status).json({ error: identity.error });
    return;
  }

  const validated = await validateNewEmail(userId, req.body?.newEmail);
  if (!validated.ok) {
    res.status(validated.status).json({ error: validated.error });
    return;
  }

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();
  await clearSecurityOtp(userId, "update_email");
  await db.insert(securityOtpsTable).values({
    userId,
    action: "update_email",
    otp,
    payload: validated.newEmail,
    expiresAt,
  });

  try {
    await sendNewEmailVerificationOtp(validated.newEmail, user.name, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to send new email verification code");
    // Nothing is half-changed: the challenge is dropped so the user can start
    // again rather than waiting for a code that was never sent.
    await clearSecurityOtp(userId, "update_email");
    res
      .status(500)
      .json({ error: "Failed to send verification code. Please try again." });
    return;
  }

  res.json({ message: "Verification code sent", email: validated.newEmail });
};

// POST /api/v2/settings/security/resend-email-change — resends the pending
// code to the address being claimed. The v1 resend sends to the account's
// current email, which is the wrong mailbox for this flow.
export const resendEmailChangeOtpV2 = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;

  const [[user], [pending]] = await Promise.all([
    db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
    db
      .select({
        id: securityOtpsTable.id,
        payload: securityOtpsTable.payload,
        createdAt: securityOtpsTable.createdAt,
      })
      .from(securityOtpsTable)
      .where(
        and(
          eq(securityOtpsTable.userId, userId),
          eq(securityOtpsTable.action, "update_email"),
        ),
      )
      .limit(1),
  ]);
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  if (!pending?.payload) {
    res.status(400).json({
      error: "No pending verification. Please start the request again.",
    });
    return;
  }
  if (isWithinOtpCooldown(pending.createdAt)) {
    res.status(429).json({ error: OTP_COOLDOWN_ERROR });
    return;
  }

  // The address is re-checked because someone else may have claimed it while
  // this request was waiting.
  const validated = await validateNewEmail(userId, pending.payload);
  if (!validated.ok) {
    await clearSecurityOtp(userId, "update_email");
    res.status(validated.status).json({ error: validated.error });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();
  try {
    await sendNewEmailVerificationOtp(validated.newEmail, user.name, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to resend new email verification code");
    res
      .status(500)
      .json({ error: "Failed to send verification code. Please try again." });
    return;
  }
  await db
    .update(securityOtpsTable)
    .set({ otp, expiresAt, attempts: 0, createdAt: new Date() })
    .where(eq(securityOtpsTable.id, pending.id));

  res.json({ message: "Verification code sent", email: validated.newEmail });
};
