import type { Response } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  messesTable,
  consumersTable,
  depositEntriesTable,
  depositsTable,
  mealOptOutsTable,
  mealsTable,
  usersTable,
  memberRequestsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  sendExistingMemberAddedEmail,
  sendWelcomeEmail,
  sendInviteEmail,
} from "../lib/email.js";
import { getMessContext } from "../lib/mess-access.js";
import { normalizeEmail } from "../utils/authUtils.js";
import {
  getPendingMemberRequest,
  toPendingRequestResponse,
  updateMemberRequestStatus,
} from "../utils/memberRequestUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import {
  generateMessKey,
  generateTemporaryPassword,
  toMessResponse,
} from "../utils/messUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { hashPassword } from "../utils/passwordUtils.js";

// POST /api/mess/create — user can create multiple messes
export const createMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { name } = req.body ?? {};
  if (!name?.trim()) {
    res.status(400).json({ error: "Mess name is required" });
    return;
  }

  const messKey = generateMessKey();
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

  res.json({ mess: toMessResponse(mess) });
};

// POST /api/mess/join — user can join multiple messes; re-request after rejection
export const joinMess = async (req: AuthedRequest, res: Response) => {
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
    .where(
      and(
        eq(consumersTable.userId, userId),
        eq(consumersTable.messId, mess.id),
      ),
    )
    .limit(1);
  if (existingConsumer) {
    res.status(409).json({ error: "You are already a member of this mess" });
    return;
  }

  const [existingRequest] = await db
    .select({ id: memberRequestsTable.id, status: memberRequestsTable.status })
    .from(memberRequestsTable)
    .where(
      and(
        eq(memberRequestsTable.messId, mess.id),
        eq(memberRequestsTable.userId, userId),
      ),
    )
    .limit(1);

  if (existingRequest) {
    if (existingRequest.status === "pending") {
      res
        .status(409)
        .json({ error: "You already have a pending request for this mess" });
      return;
    }
    if (existingRequest.status === "rejected") {
      await updateMemberRequestStatus(existingRequest.id, "pending");
      res.json({
        pendingRequest: toPendingRequestResponse(existingRequest.id, mess),
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
    pendingRequest: toPendingRequestResponse(request.id, mess),
  });
};

// GET /api/mess/member-requests?messId=X — admin only
export const getMemberRequests = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

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
};

// POST /api/mess/member-requests/:id/accept — admin only
export const acceptMemberRequest = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const requestId = parsePositiveInteger(req.params.id);
  const memberRequest = requestId
    ? await getPendingMemberRequest(requestId)
    : null;
  if (!memberRequest) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  const access = await resolveMessAccess(userId, memberRequest.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;

  await updateMemberRequestStatus(memberRequest.id, "accepted");

  const [consumer] = await db
    .insert(consumersTable)
    .values({
      messId: mess.id,
      name: memberRequest.name,
      userId: memberRequest.userId,
    })
    .returning({ id: consumersTable.id, name: consumersTable.name });

  res.json({ consumer });
};

// POST /api/mess/member-requests/:id/reject — admin only
export const rejectMemberRequest = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const requestId = parsePositiveInteger(req.params.id);
  const memberRequest = requestId
    ? await getPendingMemberRequest(requestId)
    : null;
  if (!memberRequest) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  const access = await resolveMessAccess(userId, memberRequest.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  await updateMemberRequestStatus(memberRequest.id, "rejected");

  res.json({ success: true });
};

// GET /api/mess/info?messId=X
export const getMessInfo = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const messId = parsePositiveInteger(req.query.messId);
  if (!messId) {
    res.status(400).json({ error: "messId query param is required" });
    return;
  }
  const { mess, role } = await getMessContext(userId, messId);
  if (!mess) {
    res.json({ mess: null, role: null });
    return;
  }
  res.json({
    mess: toMessResponse(mess),
    role,
  });
};

// GET /api/mess/consumers?messId=X
export const getConsumers = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    missingMessIdError: "messId query param is required",
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
      mobileNumber: usersTable.mobileNumber,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, mess.id));
  res.json({ consumers });
};

// POST /api/mess/consumers — admin only; body: { messId, name, email, mobileNumber }
export const addConsumer = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, name, email, mobileNumber } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!name?.trim()) {
    res.status(400).json({ error: "Consumer name is required" });
    return;
  }
  if (!email?.trim()) {
    res
      .status(400)
      .json({ error: "Email is required to create a consumer account" });
    return;
  }

  const consumerName = (name as string).trim();
  const normalizedEmail = normalizeEmail(email as string);
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
    const [existingConsumer] = await db
      .select({ id: consumersTable.id })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, mess.id),
          eq(consumersTable.userId, existingUser.id),
        ),
      )
      .limit(1);
    if (existingConsumer) {
      res.status(409).json({ error: "This user is already a member of this mess" });
      return;
    }

    const [consumer] = await db
      .insert(consumersTable)
      .values({
        messId: mess.id,
        name: consumerName,
        userId: existingUser.id,
      })
      .returning({ id: consumersTable.id, name: consumersTable.name });

    sendExistingMemberAddedEmail(
      normalizedEmail,
      consumerName,
      mess.name,
      mess.messKey,
    ).catch((err: unknown) => {
      req.log.error({ err }, "Failed to send added-to-mess email");
    });

    res.json({ consumer, invitationSent: true });
    return;
  }

  const plainPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(plainPassword);

  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      name: consumerName,
      passwordHash,
      mobileNumber: normalizedMobile,
    })
    .returning({ id: usersTable.id });

  sendWelcomeEmail(
    normalizedEmail,
    consumerName,
    mess.name,
    plainPassword,
  ).catch((err: unknown) => {
    req.log.error({ err }, "Failed to send welcome email to new consumer");
  });

  const [consumer] = await db
    .insert(consumersTable)
    .values({ messId: mess.id, name: consumerName, userId: newUser.id })
    .returning({ id: consumersTable.id, name: consumersTable.name });

  res.json({ consumer, invitationSent: false });
};

// DELETE /api/mess/consumers/:id?messId=X — admin only; cannot delete admin consumers
export const deleteConsumer = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  const consumerId = parsePositiveInteger(req.params.id);

  if (!consumerId) {
    res.status(404).json({ error: "Consumer not found" });
    return;
  }

  const [target] = await db
    .select({
      id: consumersTable.id,
      isAdmin: consumersTable.isAdmin,
      userId: consumersTable.userId,
    })
    .from(consumersTable)
    .where(
      and(
        eq(consumersTable.id, consumerId),
        eq(consumersTable.messId, mess.id),
      ),
    )
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "Consumer not found" });
    return;
  }
  if (target.isAdmin) {
    res.status(403).json({
      error: "Admin members cannot be deleted. Remove their admin role first.",
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(mealOptOutsTable)
      .where(
        and(
          eq(mealOptOutsTable.consumerId, consumerId),
          eq(mealOptOutsTable.messId, mess.id),
        ),
      );
    await tx
      .delete(depositEntriesTable)
      .where(
        and(
          eq(depositEntriesTable.consumerId, consumerId),
          eq(depositEntriesTable.messId, mess.id),
        ),
      );
    await tx
      .delete(depositsTable)
      .where(
        and(
          eq(depositsTable.consumerId, consumerId),
          eq(depositsTable.messId, mess.id),
        ),
      );
    await tx
      .delete(mealsTable)
      .where(
        and(
          eq(mealsTable.consumerId, consumerId),
          eq(mealsTable.messId, mess.id),
        ),
      );
    await tx
      .delete(consumersTable)
      .where(
        and(
          eq(consumersTable.id, consumerId),
          eq(consumersTable.messId, mess.id),
        ),
      );
  });
  res.json({ success: true });
};

// POST /api/mess/invite — admin sends mess join key to an email address
export const inviteToMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, toEmail } = req.body ?? {};
  const access = await resolveMessAccess(userId, messIdRaw, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { mess } = access;
  if (!toEmail?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim())) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }
  const [adminUser] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  sendInviteEmail(
    normalizeEmail(toEmail as string),
    adminUser?.name ?? "Admin",
    mess.name,
    mess.messKey,
  ).catch((err: unknown) => {
    req.log.error({ err }, "Failed to send invite email");
  });

  res.json({ success: true });
};

// POST /api/mess/rejoin — re-request to join after rejection (no mess key needed)
export const rejoinMess = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { requestId } = req.body ?? {};
  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }
  const parsedRequestId = parsePositiveInteger(requestId);
  if (!parsedRequestId) {
    res.status(404).json({ error: "Rejected request not found" });
    return;
  }

  const [existingRequest] = await db
    .select()
    .from(memberRequestsTable)
    .where(
      and(
        eq(memberRequestsTable.id, parsedRequestId),
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

  await updateMemberRequestStatus(existingRequest.id, "pending");

  res.json({
    request: toPendingRequestResponse(existingRequest.id, {
      id: existingRequest.messId,
      name: mess?.name ?? "Unknown Mess",
    }),
  });
};
