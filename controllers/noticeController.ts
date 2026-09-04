import type { Response } from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  ne,
  sql,
} from "drizzle-orm";
import {
  consumersTable,
  db,
  noticeReadStatesTable,
  noticesTable,
  notificationsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { deliverNoticePushes } from "../lib/notificationDelivery.js";

const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 5000;
const DEFAULT_NOTICE_COLOR = "#F0FDFA";
const NOTICE_COLORS = new Set([
  "#F0FDFA",
  "#FEF3C7",
  "#DBEAFE",
  "#DCFCE7",
  "#FCE7F3",
  "#EDE9FE",
  "#FFEDD5",
]);

const readNoticeFields = (body: unknown) => {
  const input = body as {
    title?: unknown;
    body?: unknown;
    color?: unknown;
  } | null;
  const title = String(input?.title ?? "").trim();
  const noticeBody = String(input?.body ?? "").trim();
  const color = String(input?.color ?? DEFAULT_NOTICE_COLOR).toUpperCase();

  if (!title || title.length > MAX_TITLE_LENGTH) {
    return {
      error: `title is required and must be at most ${MAX_TITLE_LENGTH} characters`,
    };
  }
  if (!noticeBody || noticeBody.length > MAX_BODY_LENGTH) {
    return {
      error: `body is required and must be at most ${MAX_BODY_LENGTH} characters`,
    };
  }
  if (!NOTICE_COLORS.has(color)) {
    return { error: "color must be one of the available notice colors" };
  }
  return { title, body: noticeBody, color };
};

export const getNotices = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const notices = await db
    .select()
    .from(noticesTable)
    .where(eq(noticesTable.messId, access.messId))
    .orderBy(asc(noticesTable.serialNo));

  res.json({ notices });
};

export const createNotice = async (req: AuthedRequest, res: Response) => {
  const input = readNoticeFields(req.body);
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }

  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const existingNotices = await tx
      .select({ id: noticesTable.id, serialNo: noticesTable.serialNo })
      .from(noticesTable)
      .where(eq(noticesTable.messId, access.messId))
      .orderBy(asc(noticesTable.serialNo));
    const offset = existingNotices.length + 1;

    if (existingNotices.length > 0) {
      await tx
        .update(noticesTable)
        .set({ serialNo: sql`${noticesTable.serialNo} + ${offset}` })
        .where(eq(noticesTable.messId, access.messId));
      for (const [index, existingNotice] of existingNotices.entries()) {
        await tx
          .update(noticesTable)
          .set({ serialNo: index + 2 })
          .where(
            and(
              eq(noticesTable.id, existingNotice.id),
              eq(noticesTable.messId, access.messId),
            ),
          );
      }
    }

    const [created] = await tx
      .insert(noticesTable)
      .values({
        messId: access.messId,
        serialNo: 1,
        title: input.title,
        body: input.body,
        color: input.color,
        createdByUserId: req.auth!.userId,
      })
      .returning();

    const recipients = await tx
      .select({ userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, access.messId),
          isNull(consumersTable.accountDeletedAt),
        ),
      );
    const pushRecipientUserIds = [
      ...new Set(
        recipients.flatMap((recipient) =>
          recipient.userId == null ? [] : [recipient.userId],
        ),
      ),
    ];

    return { notice: created!, pushRecipientUserIds };
  });

  void deliverNoticePushes({
    recipientUserIds: result.pushRecipientUserIds,
    messId: access.messId,
    noticeId: result.notice.id,
    title: result.notice.title,
    body: result.notice.body,
  });
  res.status(201).json({ notice: result.notice });
};

const getUnreadNoticeCount = async (messId: number, userId: number) => {
  const [readState] = await db
    .select({ lastReadNoticeId: noticeReadStatesTable.lastReadNoticeId })
    .from(noticeReadStatesTable)
    .where(
      and(
        eq(noticeReadStatesTable.messId, messId),
        eq(noticeReadStatesTable.userId, userId),
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
    ? gt(noticesTable.id, readState.lastReadNoticeId ?? 0)
    : membership
      ? gt(noticesTable.createdAt, membership.joinedAt)
      : gt(noticesTable.id, 0);
  const [result] = await db
    .select({ total: count() })
    .from(noticesTable)
    .where(
      and(
        eq(noticesTable.messId, messId),
        unreadBoundary,
        ne(noticesTable.createdByUserId, userId),
      ),
    );
  return Number(result?.total ?? 0);
};

export const getUnreadNoticesCount = async (
  req: AuthedRequest,
  res: Response,
) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const unreadCount = await getUnreadNoticeCount(
    access.messId,
    req.auth!.userId,
  );
  res.json({ unreadCount });
};

export const markNoticesRead = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [latest] = await db
    .select({ id: max(noticesTable.id) })
    .from(noticesTable)
    .where(eq(noticesTable.messId, access.messId));
  const latestNoticeId = latest?.id == null ? null : Number(latest.id);
  await db
    .insert(noticeReadStatesTable)
    .values({
      messId: access.messId,
      userId: req.auth!.userId,
      lastReadNoticeId: latestNoticeId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [noticeReadStatesTable.messId, noticeReadStatesTable.userId],
      set: {
        lastReadNoticeId: latestNoticeId,
        updatedAt: new Date(),
      },
    });

  res.json({ unreadCount: 0 });
};

export const updateNotice = async (req: AuthedRequest, res: Response) => {
  const input = readNoticeFields(req.body);
  if ("error" in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  const noticeId = parsePositiveInteger(req.params.id);
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!noticeId || !access.ok) {
    res.status(!access.ok ? access.status : 400).json({
      error: !access.ok ? access.error : "notice id is required",
    });
    return;
  }

  const [notice] = await db
    .update(noticesTable)
    .set({
      title: input.title,
      body: input.body,
      color: input.color,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(noticesTable.id, noticeId),
        eq(noticesTable.messId, access.messId),
      ),
    )
    .returning();
  if (!notice) {
    res.status(404).json({ error: "Notice not found" });
    return;
  }

  res.json({ notice });
};

export const deleteNotice = async (req: AuthedRequest, res: Response) => {
  const noticeId = parsePositiveInteger(req.params.id);
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId, {
    adminOnly: true,
  });
  if (!noticeId || !access.ok) {
    res.status(!access.ok ? access.status : 400).json({
      error: !access.ok ? access.error : "notice id is required",
    });
    return;
  }

  const [notice] = await db
    .delete(noticesTable)
    .where(
      and(
        eq(noticesTable.id, noticeId),
        eq(noticesTable.messId, access.messId),
      ),
    )
    .returning({ id: noticesTable.id });
  if (!notice) {
    res.status(404).json({ error: "Notice not found" });
    return;
  }

  res.json({ success: true });
};

export const reorderNotices = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId, {
    adminOnly: true,
  });
  const noticeIds = req.body?.noticeIds;
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  if (
    !Array.isArray(noticeIds) ||
    noticeIds.length === 0 ||
    noticeIds.some((id: unknown) => !parsePositiveInteger(id)) ||
    new Set(noticeIds).size !== noticeIds.length
  ) {
    res
      .status(400)
      .json({ error: "noticeIds must be a unique non-empty array" });
    return;
  }

  const notices = await db
    .select({ id: noticesTable.id })
    .from(noticesTable)
    .where(
      and(
        eq(noticesTable.messId, access.messId),
        inArray(
          noticesTable.id,
          noticeIds.map((id: number) => parsePositiveInteger(id)!),
        ),
      ),
    );
  if (notices.length !== noticeIds.length) {
    res.status(400).json({ error: "noticeIds must belong to this mess" });
    return;
  }

  await db.transaction(async (tx) => {
    const offset = noticeIds.length + 1;
    await tx
      .update(noticesTable)
      .set({ serialNo: sql`${noticesTable.serialNo} + ${offset}` })
      .where(eq(noticesTable.messId, access.messId));
    for (const [index, rawId] of noticeIds.entries()) {
      await tx
        .update(noticesTable)
        .set({ serialNo: index + 1, updatedAt: new Date() })
        .where(
          and(
            eq(noticesTable.id, parsePositiveInteger(rawId)!),
            eq(noticesTable.messId, access.messId),
          ),
        );
    }
  });

  const reordered = await db
    .select()
    .from(noticesTable)
    .where(eq(noticesTable.messId, access.messId))
    .orderBy(asc(noticesTable.serialNo));
  res.json({ notices: reordered });
};

export const getNotifications = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, req.auth!.userId),
        eq(notificationsTable.messId, access.messId),
        ne(notificationsTable.type, "message"),
        ne(notificationsTable.type, "notice"),
      ),
    )
    .orderBy(desc(notificationsTable.createdAt));
  res.json({ notifications });
};

export const markNotificationRead = async (
  req: AuthedRequest,
  res: Response,
) => {
  const notificationId = parsePositiveInteger(req.params.id);
  if (!notificationId) {
    res.status(400).json({ error: "notification id is required" });
    return;
  }

  const [notification] = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.id, notificationId),
        eq(notificationsTable.userId, req.auth!.userId),
      ),
    )
    .returning({ id: notificationsTable.id });
  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json({ success: true });
};
