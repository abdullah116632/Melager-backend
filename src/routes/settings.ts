import { Router } from "express";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  messesTable,
  consumersTable,
  securityOtpsTable,
} from "../../db/index.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendSecurityOtpEmail } from "../lib/email.js";

const router = Router();

type SecurityAction = "change_password" | "update_email" | "add_admin" | "add_co_admin";
const VALID_ACTIONS: SecurityAction[] = ["change_password", "update_email", "add_admin", "add_co_admin"];

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function clearOtp(userId: number, action: SecurityAction) {
  await db
    .delete(securityOtpsTable)
    .where(
      and(
        eq(securityOtpsTable.userId, userId),
        eq(securityOtpsTable.action, action),
      ),
    );
}

async function verifyPendingOtp(userId: number, action: SecurityAction, otpInput: string) {
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

  if (!pending) return { error: "No pending verification. Please request a new code.", expired: false };
  if (new Date() > pending.expiresAt) {
    await clearOtp(userId, action);
    return { error: "Code expired. Please request a new one.", expired: true };
  }
  if (pending.otp !== otpInput.trim()) return { error: "Incorrect code. Please try again.", expired: false };
  return { pending };
}

// POST /api/settings/security/request-otp
router.post("/settings/security/request-otp", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { action, currentPassword, payload } = req.body ?? {};

  if (!action || !VALID_ACTIONS.includes(action as SecurityAction)) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const act = action as SecurityAction;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  if (act === "change_password") {
    if (!currentPassword) { res.status(400).json({ error: "Current password is required" }); return; }
    const valid = await bcrypt.compare(currentPassword as string, user.passwordHash);
    if (!valid) { res.status(401).json({ error: "Current password is incorrect" }); return; }
  }

  if (act === "update_email") {
    if (!payload) { res.status(400).json({ error: "New email is required" }); return; }
    const newEmail = (payload as string).toLowerCase().trim();
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
    const messId = parseInt(messIdParam, 10);
    if (!messId || isNaN(messId)) { res.status(400).json({ error: "messId is required" }); return; }
    const [mess] = await db
      .select()
      .from(messesTable)
      .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messId)))
      .limit(1);
    if (!mess) { res.status(403).json({ error: "Only the primary admin can perform this action" }); return; }
    if (!payload) { res.status(400).json({ error: "Consumer ID is required" }); return; }
    const consumerId = parseInt(payload as string, 10);
    const [consumer] = await db
      .select()
      .from(consumersTable)
      .where(and(eq(consumersTable.id, consumerId), eq(consumersTable.messId, mess.id)))
      .limit(1);
    if (!consumer || !consumer.userId) {
      res.status(400).json({ error: "Selected member does not have a linked account" });
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
    storedPayload = `${messId}:${consumerId}`;
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await clearOtp(userId, act);
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
    res.status(500).json({ error: "Failed to send verification code. Please try again." });
    return;
  }

  res.json({ message: "Verification code sent" });
});

// POST /api/settings/security/change-password
router.post("/settings/security/change-password", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { otp, newPassword } = req.body ?? {};

  if (!otp || !newPassword) {
    res.status(400).json({ error: "otp and newPassword are required" });
    return;
  }
  if ((newPassword as string).length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  const result = await verifyPendingOtp(userId, "change_password", otp as string);
  if (result.error) { res.status(result.expired ? 410 : 401).json({ error: result.error }); return; }

  const passwordHash = await bcrypt.hash(newPassword as string, 10);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
  await clearOtp(userId, "change_password");

  res.json({ message: "Password changed successfully" });
});

// POST /api/settings/security/update-email
router.post("/settings/security/update-email", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) { res.status(400).json({ error: "otp is required" }); return; }

  const result = await verifyPendingOtp(userId, "update_email", otp as string);
  if (result.error) { res.status(result.expired ? 410 : 401).json({ error: result.error }); return; }

  const newEmail = result.pending!.payload!.toLowerCase().trim();
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, newEmail))
    .limit(1);
  if (existing && existing.id !== userId) {
    await clearOtp(userId, "update_email");
    res.status(409).json({ error: "This email address is already in use" });
    return;
  }

  await db.update(usersTable).set({ email: newEmail }).where(eq(usersTable.id, userId));
  await clearOtp(userId, "update_email");

  res.json({ message: "Email updated successfully", newEmail });
});

// POST /api/settings/security/add-admin
router.post("/settings/security/add-admin", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) { res.status(400).json({ error: "otp is required" }); return; }

  const result = await verifyPendingOtp(userId, "add_admin", otp as string);
  if (result.error) { res.status(result.expired ? 410 : 401).json({ error: result.error }); return; }

  const rawPayload = result.pending!.payload!;
  const colonIdx = rawPayload.indexOf(':');
  const messIdFromPayload = colonIdx !== -1 ? parseInt(rawPayload.substring(0, colonIdx), 10) : 0;
  const consumerId = colonIdx !== -1 ? parseInt(rawPayload.substring(colonIdx + 1), 10) : parseInt(rawPayload, 10);

  const [consumer] = await db
    .select()
    .from(consumersTable)
    .where(eq(consumersTable.id, consumerId))
    .limit(1);
  if (!consumer || !consumer.userId) {
    res.status(400).json({ error: "Consumer no longer has a linked account" });
    return;
  }

  const [mess] = await db
    .select()
    .from(messesTable)
    .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messIdFromPayload)))
    .limit(1);
  if (!mess) { res.status(403).json({ error: "You are no longer the admin of this mess" }); return; }

  await db
    .update(messesTable)
    .set({ adminUserId: consumer.userId })
    .where(eq(messesTable.id, mess.id));
  await clearOtp(userId, "add_admin");

  res.json({ message: "Admin role transferred successfully" });
});

// POST /api/settings/security/add-co-admin — grant admin to a member without revoking current admin
router.post("/settings/security/add-co-admin", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { otp } = req.body ?? {};

  if (!otp) { res.status(400).json({ error: "otp is required" }); return; }

  const result = await verifyPendingOtp(userId, "add_co_admin", otp as string);
  if (result.error) { res.status(result.expired ? 410 : 401).json({ error: result.error }); return; }

  const rawCoAdmin = result.pending!.payload!;
  const colonIdxCoAdmin = rawCoAdmin.indexOf(':');
  const messIdCoAdmin = colonIdxCoAdmin !== -1 ? parseInt(rawCoAdmin.substring(0, colonIdxCoAdmin), 10) : 0;
  const consumerId = colonIdxCoAdmin !== -1 ? parseInt(rawCoAdmin.substring(colonIdxCoAdmin + 1), 10) : parseInt(rawCoAdmin, 10);

  const [consumer] = await db
    .select()
    .from(consumersTable)
    .where(eq(consumersTable.id, consumerId))
    .limit(1);
  if (!consumer || !consumer.userId) {
    res.status(400).json({ error: "Consumer no longer has a linked account" });
    return;
  }

  const [mess] = await db
    .select()
    .from(messesTable)
    .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messIdCoAdmin)))
    .limit(1);
  if (!mess) { res.status(403).json({ error: "You are no longer the primary admin of this mess" }); return; }

  await db
    .update(consumersTable)
    .set({ isAdmin: true })
    .where(eq(consumersTable.id, consumerId));
  await clearOtp(userId, "add_co_admin");

  res.json({ message: "Admin privileges granted successfully" });
});

// GET /api/settings/security/eligible-admins?messId=X
router.get("/settings/security/eligible-admins", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = parseInt(req.query.messId as string, 10);
  if (!messId || isNaN(messId)) { res.status(400).json({ error: "messId query param is required" }); return; }

  const [mess] = await db
    .select()
    .from(messesTable)
    .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messId)))
    .limit(1);
  if (!mess) { res.status(403).json({ error: "Only the primary admin can view this" }); return; }

  const consumers = await db
    .select({ id: consumersTable.id, name: consumersTable.name, userId: consumersTable.userId, isAdmin: consumersTable.isAdmin })
    .from(consumersTable)
    .where(eq(consumersTable.messId, mess.id));

  const eligible = consumers.filter((c) => c.userId !== null && c.userId !== userId);
  res.json({ consumers: eligible });
});

// PATCH /api/settings/profile — update display name
router.patch("/settings/profile", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { name } = req.body ?? {};
  if (!name?.trim()) { res.status(400).json({ error: "Name is required" }); return; }
  if ((name as string).trim().length > 100) { res.status(400).json({ error: "Name is too long" }); return; }
  await db.update(usersTable).set({ name: (name as string).trim() }).where(eq(usersTable.id, userId));
  res.json({ name: (name as string).trim() });
});

// PATCH /api/settings/profile/phone — update mobile number
router.patch("/settings/profile/phone", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { phone } = req.body ?? {};
  const trimmed = phone != null ? (phone as string).trim() : null;
  if (trimmed && trimmed.length > 20) {
    res.status(400).json({ error: "Phone number is too long" });
    return;
  }
  await db.update(usersTable).set({ mobileNumber: trimmed || null }).where(eq(usersTable.id, userId));
  res.json({ mobileNumber: trimmed || null });
});

// PATCH /api/settings/mess — update mess name (admin only)
router.patch("/settings/mess", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { name, messId: messIdParam } = req.body ?? {};
  if (!name?.trim()) { res.status(400).json({ error: "Mess name is required" }); return; }
  if ((name as string).trim().length > 100) { res.status(400).json({ error: "Mess name is too long" }); return; }
  const messId = parseInt(messIdParam, 10);
  if (!messId || isNaN(messId)) { res.status(400).json({ error: "messId is required" }); return; }
  const [mess] = await db
    .select()
    .from(messesTable)
    .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messId)))
    .limit(1);
  if (!mess) { res.status(403).json({ error: "Only the primary admin can update the mess name" }); return; }
  await db.update(messesTable).set({ name: (name as string).trim() }).where(eq(messesTable.id, mess.id));
  res.json({ name: (name as string).trim() });
});

export default router;
