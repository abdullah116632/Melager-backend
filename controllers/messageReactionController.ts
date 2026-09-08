import type { Response } from "express";
import { and, eq, inArray } from "drizzle-orm";

import {
  MESSAGE_REACTIONS,
  db,
  messageReactionsTable,
  messagesTable,
  type MessageReactionKind,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { emitToMess } from "../realtime/socket.js";

export interface MessageReactionRow {
  userId: number;
  reaction: string;
}

const isReaction = (value: unknown): value is MessageReactionKind =>
  MESSAGE_REACTIONS.includes(value as MessageReactionKind);

/**
 * Reaction rows for the given messages, keyed by message id. Counts are left
 * to the client so that "which one did I pick" needs no extra query.
 */
export const loadMessageReactions = async (
  messageIds: number[],
): Promise<Map<number, MessageReactionRow[]>> => {
  const reactions = new Map<number, MessageReactionRow[]>();
  if (messageIds.length === 0) return reactions;

  const rows = await db
    .select({
      messageId: messageReactionsTable.messageId,
      userId: messageReactionsTable.userId,
      reaction: messageReactionsTable.reaction,
    })
    .from(messageReactionsTable)
    .where(inArray(messageReactionsTable.messageId, messageIds));

  for (const row of rows) {
    const existing = reactions.get(row.messageId);
    const entry = { userId: row.userId, reaction: row.reaction };
    if (existing) existing.push(entry);
    else reactions.set(row.messageId, [entry]);
  }
  return reactions;
};

/**
 * Sets or clears the caller's reaction on one message. Replaying the same
 * request is harmless, so an offline queue can retry it without a mutation id.
 */
export const setMessageReaction = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const userId = req.auth!.userId;
  const messageId = parsePositiveInteger(req.body?.messageId);
  const rawReaction = req.body?.reaction ?? null;
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  if (rawReaction !== null && !isReaction(rawReaction)) {
    res.status(400).json({ error: "reaction is not supported" });
    return;
  }

  const access = await resolveMessAccess(userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [message] = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.id, messageId),
        eq(messagesTable.messId, access.messId),
      ),
    )
    .limit(1);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (rawReaction === null) {
    await db
      .delete(messageReactionsTable)
      .where(
        and(
          eq(messageReactionsTable.messageId, messageId),
          eq(messageReactionsTable.userId, userId),
        ),
      );
  } else {
    await db
      .insert(messageReactionsTable)
      .values({ messageId, userId, reaction: rawReaction })
      .onConflictDoUpdate({
        target: [messageReactionsTable.messageId, messageReactionsTable.userId],
        set: { reaction: rawReaction, updatedAt: new Date() },
      });
  }

  const change = {
    messId: access.messId,
    messageId,
    userId,
    reaction: rawReaction as MessageReactionKind | null,
  };
  emitToMess(access.messId, "message:reaction", change);
  res.json({ reaction: change });
};
