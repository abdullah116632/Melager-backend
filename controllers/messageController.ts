import type { Response } from "express";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import {
  consumersTable,
  db,
  messagesTable,
  notificationsTable,
  usersTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { deliverNotifications } from "../lib/notificationDelivery.js";

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 2000;

const parseLimit = (value: unknown) => {
  const parsed = Number(value ?? DEFAULT_MESSAGE_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(parsed, MAX_MESSAGE_LIMIT);
};

const parseCursorDate = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const getMessages = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const limit = parseLimit(req.query.limit);
  const beforeDate = parseCursorDate(req.query.beforeCreatedAt);
  const beforeId = req.query.beforeId
    ? parsePositiveInteger(req.query.beforeId)
    : null;
  if ((req.query.beforeCreatedAt || req.query.beforeId) && (!beforeDate || !beforeId)) {
    res.status(400).json({ error: "beforeCreatedAt and beforeId must form a valid cursor" });
    return;
  }

  const cursorCondition = beforeDate && beforeId
    ? or(
        lt(messagesTable.createdAt, beforeDate),
        and(eq(messagesTable.createdAt, beforeDate), lt(messagesTable.id, beforeId)),
      )
    : undefined;
  const rows = await db
    .select({
      id: messagesTable.id,
      messId: messagesTable.messId,
      senderUserId: messagesTable.senderUserId,
      senderName: usersTable.name,
      body: messagesTable.body,
      createdAt: messagesTable.createdAt,
      updatedAt: messagesTable.updatedAt,
    })
    .from(messagesTable)
    .innerJoin(usersTable, eq(messagesTable.senderUserId, usersTable.id))
    .where(cursorCondition
      ? and(eq(messagesTable.messId, access.messId), cursorCondition)
      : eq(messagesTable.messId, access.messId))
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  const last = messages[messages.length - 1];
  res.json({
    messages,
    nextCursor: hasMore && last
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  });
};

export const createMessage = async (req: AuthedRequest, res: Response) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({
      error: `message body is required and must be at most ${MAX_MESSAGE_LENGTH} characters`,
    });
    return;
  }

  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [sender] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, req.auth!.userId))
    .limit(1);
  if (!sender) {
    res.status(401).json({ error: "Authenticated user not found" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messagesTable)
      .values({
        messId: access.messId,
        senderUserId: req.auth!.userId,
        body,
      })
      .returning();

    const recipients = await tx
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, access.messId),
          isNull(consumersTable.accountDeletedAt),
          sql`${consumersTable.userId} is not null`,
        ),
      );
    const notificationRows = recipients
      .filter((recipient) => recipient.userId != null && recipient.userId !== req.auth!.userId)
      .map((recipient) => ({
        messId: access.messId,
        userId: recipient.userId!,
        type: "message",
        title: `New message from ${sender.name}`,
        body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
      }));
    const notifications =
      notificationRows.length > 0
        ? await tx.insert(notificationsTable).values(notificationRows).returning()
        : [];

    return {
      message: { ...created!, senderName: sender.name },
      notifications,
    };
  });

  void deliverNotifications(result.notifications);
  res.status(201).json({ message: result.message });
};
