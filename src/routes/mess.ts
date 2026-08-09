import { Router } from "express";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  db,
  messesTable,
  consumersTable,
  usersTable,
  memberRequestsTable,
} from "../../db/index.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendWelcomeEmail, sendInviteEmail } from "../lib/email.js";
import { getMessContext } from "../lib/mess-access.js";

const router = Router();

function requireMessId(raw: unknown): number | null {
  const n = parseInt(raw as string, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

// POST /api/mess/create — user can create multiple messes
router.post("/mess/create", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { name } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Mess name is required" });
    return;
  }

  const messKey = crypto.randomBytes(4).toString("hex").toUpperCase();
  const [mess] = await db
    .insert(messesTable)
    .values({ name: name.trim(), messKey, adminUserId: userId })
    .returning();

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  await db.insert(consumersTable).values({
    messId: mess.id,
    name: user?.name ?? "Admin",
    userId,
    isAdmin: true,
  });

  res.json({ mess: { id: mess.id, name: mess.name, messKey: mess.messKey } });
});

// POST /api/mess/join — user can join multiple messes; re-request after rejection
router.post("/mess/join", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messKey } = req.body ?? {};
  if (!messKey?.trim()) {
    res.status(400).json({ error: "messKey is required" });
    return;
  }

  const [mess] = await db
    .select()
    .from(messesTable)
    .where(eq(messesTable.messKey, messKey.trim().toUpperCase()))
    .limit(1);
  if (!mess) {
    res.status(404).json({ error: "Invalid mess key" });
    return;
  }

  if (mess.adminUserId === userId) {
    res.status(409).json({ error: "You are already the admin of this mess" });
    return;
  }

  const [existingConsumer] = await db
    .select({ id: consumersTable.id })
    .from(consumersTable)
    .where(and(eq(consumersTable.userId, userId), eq(consumersTable.messId, mess.id)))
    .limit(1);
  if (existingConsumer) {
    res.status(409).json({ error: "You are already a member of this mess" });
    return;
  }

  const [existingRequest] = await db
    .select({ id: memberRequestsTable.id, status: memberRequestsTable.status })
    .from(memberRequestsTable)
    .where(
      and(eq(memberRequestsTable.messId, mess.id), eq(memberRequestsTable.userId, userId)),
    )
    .limit(1);

  if (existingRequest) {
    if (existingRequest.status === "pending") {
      res.status(409).json({ error: "You already have a pending request for this mess" });
      return;
    }
    if (existingRequest.status === "rejected") {
      await db
        .update(memberRequestsTable)
        .set({ status: "pending" })
        .where(eq(memberRequestsTable.id, existingRequest.id));
      res.json({
        pendingRequest: {
          id: existingRequest.id,
          messId: mess.id,
          messName: mess.name,
          status: "pending",
        },
      });
      return;
    }
  }

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const [request] = await db
    .insert(memberRequestsTable)
    .values({
      messId: mess.id,
      userId,
      name: user?.name ?? "Member",
      status: "pending",
    })
    .returning();

  res.json({
    pendingRequest: {
      id: request.id,
      messId: mess.id,
      messName: mess.name,
      status: "pending",
    },
  });
});

// GET /api/mess/member-requests?messId=X — admin only
router.get("/mess/member-requests", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = requireMessId(req.query.messId);
  if (!messId) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const requests = await db
    .select({
      id: memberRequestsTable.id,
      userId: memberRequestsTable.userId,
      name: memberRequestsTable.name,
      email: usersTable.email,
      status: memberRequestsTable.status,
      createdAt: memberRequestsTable.createdAt,
    })
    .from(memberRequestsTable)
    .leftJoin(usersTable, eq(memberRequestsTable.userId, usersTable.id))
    .where(
      and(
        eq(memberRequestsTable.messId, mess.id),
        eq(memberRequestsTable.status, "pending"),
      ),
    );

  res.json({ requests });
});

// POST /api/mess/member-requests/:id/accept — admin only
router.post(
  "/mess/member-requests/:id/accept",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const userId = req.auth!.userId;
    const requestId = parseInt(req.params.id as string, 10);

    const [memberRequest] = await db
      .select()
      .from(memberRequestsTable)
      .where(
        and(
          eq(memberRequestsTable.id, requestId),
          eq(memberRequestsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (!memberRequest) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const { mess, role } = await getMessContext(userId, memberRequest.messId);
    if (!mess || role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    await db
      .update(memberRequestsTable)
      .set({ status: "accepted" })
      .where(eq(memberRequestsTable.id, requestId));

    const [consumer] = await db
      .insert(consumersTable)
      .values({
        messId: mess.id,
        name: memberRequest.name,
        userId: memberRequest.userId,
      })
      .returning({ id: consumersTable.id, name: consumersTable.name });

    res.json({ consumer });
  },
);

// POST /api/mess/member-requests/:id/reject — admin only
router.post(
  "/mess/member-requests/:id/reject",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const userId = req.auth!.userId;
    const requestId = parseInt(req.params.id as string, 10);

    const [memberRequest] = await db
      .select({ id: memberRequestsTable.id, messId: memberRequestsTable.messId })
      .from(memberRequestsTable)
      .where(
        and(
          eq(memberRequestsTable.id, requestId),
          eq(memberRequestsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (!memberRequest) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const { mess, role } = await getMessContext(userId, memberRequest.messId);
    if (!mess || role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    await db
      .update(memberRequestsTable)
      .set({ status: "rejected" })
      .where(eq(memberRequestsTable.id, requestId));

    res.json({ success: true });
  },
);

// GET /api/mess/info?messId=X
router.get("/mess/info", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = requireMessId(req.query.messId);
  if (!messId) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess) {
    res.json({ mess: null, role: null });
    return;
  }
  res.json({ mess: { id: mess.id, name: mess.name, messKey: mess.messKey }, role });
});

// GET /api/mess/consumers?messId=X
router.get("/mess/consumers", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = requireMessId(req.query.messId);
  if (!messId) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }
  const { mess } = await getMessContext(userId, messId);
  if (!mess) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  const consumers = await db
    .select({
      id: consumersTable.id,
      name: consumersTable.name,
      userId: consumersTable.userId,
      isAdmin: consumersTable.isAdmin,
      email: usersTable.email,
      mobileNumber: usersTable.mobileNumber,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, mess.id));
  res.json({ consumers });
});

// POST /api/mess/consumers — admin only; body: { messId, name, email, mobileNumber }
router.post("/mess/consumers", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, name, email, mobileNumber } = req.body ?? {};
  const messId = requireMessId(messIdRaw);
  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  if (!name?.trim()) {
    res.status(400).json({ error: "Consumer name is required" });
    return;
  }
  if (!email?.trim()) {
    res.status(400).json({ error: "Email is required to create a consumer account" });
    return;
  }

  const normalizedEmail = (email as string).trim().toLowerCase();
  const normalizedMobile = (mobileNumber as string | undefined)?.trim() || null;

  if (normalizedMobile && normalizedMobile.length !== 11) {
    res.status(400).json({ error: "Mobile number must be exactly 11 digits" });
    return;
  }

  const [existingUser] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (existingUser) {
    res.status(409).json({
      error: `An account with this email already exists. Ask them to join using the mess key: ${mess.messKey}`,
    });
    return;
  }

  const plainPassword = crypto.randomBytes(9).toString("base64url").slice(0, 12);
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      mobileNumber: normalizedMobile,
    })
    .returning({ id: usersTable.id });

  sendWelcomeEmail(normalizedEmail, name.trim(), mess.name, plainPassword).catch(
    (err: unknown) => {
      req.log.error({ err }, "Failed to send welcome email to new consumer");
    },
  );

  const [consumer] = await db
    .insert(consumersTable)
    .values({ messId: mess.id, name: name.trim(), userId: newUser.id })
    .returning({ id: consumersTable.id, name: consumersTable.name });

  res.json({ consumer });
});

// DELETE /api/mess/consumers/:id?messId=X — admin only; cannot delete admin consumers
router.delete("/mess/consumers/:id", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = requireMessId(req.query.messId);
  if (!messId) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const consumerId = parseInt(req.params.id as string, 10);

  const [target] = await db
    .select({ id: consumersTable.id, isAdmin: consumersTable.isAdmin, userId: consumersTable.userId })
    .from(consumersTable)
    .where(and(eq(consumersTable.id, consumerId), eq(consumersTable.messId, mess.id)))
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "Consumer not found" });
    return;
  }
  if (target.isAdmin) {
    res.status(403).json({ error: "Admin members cannot be deleted. Remove their admin role first." });
    return;
  }

  await db
    .delete(consumersTable)
    .where(and(eq(consumersTable.id, consumerId), eq(consumersTable.messId, mess.id)));
  res.json({ success: true });
});

// POST /api/mess/invite — admin sends mess join key to an email address
router.post("/mess/invite", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, toEmail } = req.body ?? {};
  const messId = requireMessId(messIdRaw);
  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  if (!toEmail?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim())) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }
  const [adminUser] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  sendInviteEmail(toEmail.trim().toLowerCase(), adminUser?.name ?? "Admin", mess.name, mess.messKey).catch(
    (err: unknown) => { req.log.error({ err }, "Failed to send invite email"); },
  );

  res.json({ success: true });
});

// POST /api/mess/rejoin — re-request to join after rejection (no mess key needed)
router.post("/mess/rejoin", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { requestId } = req.body ?? {};
  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }

  const [existingRequest] = await db
    .select()
    .from(memberRequestsTable)
    .where(
      and(
        eq(memberRequestsTable.id, parseInt(requestId, 10)),
        eq(memberRequestsTable.userId, userId),
        eq(memberRequestsTable.status, "rejected"),
      ),
    )
    .limit(1);

  if (!existingRequest) {
    res.status(404).json({ error: "Rejected request not found" });
    return;
  }

  const [mess] = await db
    .select({ id: messesTable.id, name: messesTable.name })
    .from(messesTable)
    .where(eq(messesTable.id, existingRequest.messId))
    .limit(1);

  await db
    .update(memberRequestsTable)
    .set({ status: "pending" })
    .where(eq(memberRequestsTable.id, existingRequest.id));

  res.json({
    request: {
      id: existingRequest.id,
      messId: existingRequest.messId,
      messName: mess?.name ?? "Unknown Mess",
      status: "pending" as const,
    },
  });
});

export default router;
