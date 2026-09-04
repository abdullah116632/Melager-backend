import type { Response } from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  consumersTable,
  db,
  messageReadStatesTable,
  messagesTable,
  usersTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { deliverMessagePushes } from "../lib/notificationDelivery.js";
import { emitToMess, isUserViewingConversation } from "../realtime/socket.js";

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
  if (
    (req.query.beforeCreatedAt || req.query.beforeId) &&
    (!beforeDate || !beforeId)
  ) {
    res
      .status(400)
      .json({ error: "beforeCreatedAt and beforeId must form a valid cursor" });
    return;
  }

  const cursorCondition =
    beforeDate && beforeId
      ? or(
          lt(messagesTable.createdAt, beforeDate),
          and(
            eq(messagesTable.createdAt, beforeDate),
            lt(messagesTable.id, beforeId),
          ),
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
    .where(
      cursorCondition
        ? and(eq(messagesTable.messId, access.messId), cursorCondition)
        : eq(messagesTable.messId, access.messId),
    )
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  const last = messages[messages.length - 1];
  res.json({
    messages,
    nextCursor:
      hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
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
    const recipientUserIds = [
      ...new Set(
        recipients.flatMap((recipient) =>
          recipient.userId == null ? [] : [recipient.userId],
        ),
      ),
    ];
    const pushRecipientUserIds = recipientUserIds.filter(
      (userId) =>
        userId !== req.auth!.userId &&
        !isUserViewingConversation(access.messId, userId),
    );

    return {
      message: { ...created!, senderName: sender.name },
      pushRecipientUserIds,
    };
  });

  emitToMess(access.messId, "message:created", result.message);
  void deliverMessagePushes({
    recipientUserIds: result.pushRecipientUserIds,
    messId: access.messId,
    messageId: result.message.id,
    senderName: sender.name,
    body,
  });
  res.status(201).json({ message: result.message });
};

const getUnreadCount = async (messId: number, userId: number) => {
  const [readState] = await db
    .select({ lastReadMessageId: messageReadStatesTable.lastReadMessageId })
    .from(messageReadStatesTable)
    .where(
      and(
        eq(messageReadStatesTable.messId, messId),
        eq(messageReadStatesTable.userId, userId),
      ),
    )
    .limit(1);
  const [membership] = readState
    ? []
    : await db
        .select({ joinedAt: consumersTable.createdAt })
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.messId, messId),
            eq(consumersTable.userId, userId),
            isNull(consumersTable.accountDeletedAt),
          ),
        )
        .orderBy(asc(consumersTable.createdAt))
        .limit(1);
  const unreadBoundary = readState
    ? gt(messagesTable.id, readState.lastReadMessageId ?? 0)
    : membership
      ? gt(messagesTable.createdAt, membership.joinedAt)
      : gt(messagesTable.id, 0);
  const [result] = await db
    .select({ total: count() })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.messId, messId),
        unreadBoundary,
        ne(messagesTable.senderUserId, userId),
      ),
    );
  return Number(result?.total ?? 0);
};

export const getUnreadMessageCount = async (
  req: AuthedRequest,
  res: Response,
) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const unreadCount = await getUnreadCount(access.messId, req.auth!.userId);
  res.json({ unreadCount });
};

export const markMessagesRead = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [latest] = await db
    .select({ id: max(messagesTable.id) })
    .from(messagesTable)
    .where(eq(messagesTable.messId, access.messId));
  const latestMessageId = latest?.id == null ? null : Number(latest.id);
  await db
    .insert(messageReadStatesTable)
    .values({
      messId: access.messId,
      userId: req.auth!.userId,
      lastReadMessageId: latestMessageId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [messageReadStatesTable.messId, messageReadStatesTable.userId],
      set: {
        lastReadMessageId: latestMessageId,
        updatedAt: new Date(),
      },
    });

  res.json({ unreadCount: 0 });
};
