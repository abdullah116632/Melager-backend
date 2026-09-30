import type { Response } from "express";
import { and, eq, lt, sql, sum } from "drizzle-orm";

import {
  db,
  messageFileUploadsTable,
  messagesTable,
  type MessageAttachment,
} from "../db/dbConfig.js";
import { logger } from "../lib/logger.js";
import {
  isR2Configured,
  presignR2Url,
  R2_FILE_RETENTION_DAYS,
} from "../lib/r2Storage.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { dateInAppTimeZone } from "../utils/dateUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import {
  MAX_ATTACHMENT_BYTES,
  parseMessageAttachment,
} from "../utils/messageAttachmentUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

/**
 * Chat file limits and R2 storage.
 *
 * Every file sent in a mess counts against that mess's daily limit, however
 * it travels. Within the limit a phone uploads the file to R2 first, so the
 * other members can fetch it for a few days even while the sender is
 * offline; downloads are never limited. Only when the global limit that
 * guards the R2 free tier is reached does a file travel phone to phone only
 * (realtime/mediaRelay.ts).
 *
 * Limits, per calendar day in the app's time zone:
 * - one file at most 8 MB (MAX_ATTACHMENT_BYTES),
 * - one mess at most 30 MB,
 * - files stored in R2, all messes together, at most 2 GB. They stay 3 days
 *   plus up to a day until the lifecycle rule runs, so at most ~8 GB is ever
 *   held, inside R2's 10 GB free tier.
 */
const MB = 1024 * 1024;
const MESS_DAILY_LIMIT_BYTES = 30 * MB;
const GLOBAL_DAILY_STORAGE_BYTES = 2048 * MB;
const GLOBAL_WARNING_BYTES = GLOBAL_DAILY_STORAGE_BYTES * 0.8;

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;
const USAGE_ROWS_KEPT_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Serialises reservations so two files cannot both slip under a limit. */
const RESERVATION_LOCK_KEY = 7_311_204;

const FILE_TOO_LARGE_ERROR = `Files larger than ${MAX_ATTACHMENT_BYTES / MB} MB cannot be sent.`;
const MESS_LIMIT_ERROR = `This mess has used today's ${MESS_DAILY_LIMIT_BYTES / MB} MB file limit. Try again tomorrow.`;

const objectKey = (messId: number, fileId: string) =>
  `chat-files/${messId}/${fileId}`;

type FileRow = typeof messageFileUploadsTable.$inferSelect;

type Reservation =
  | { ok: true; row: FileRow }
  | { ok: false; status: 400 | 413 | 422; error: string };

const usedToday = async (
  tx: Pick<typeof db, "select">,
  today: string,
  messId: number,
) => {
  const [usage] = await tx
    .select({ total: sum(messageFileUploadsTable.sizeBytes) })
    .from(messageFileUploadsTable)
    .where(
      and(
        eq(messageFileUploadsTable.usageDate, today),
        eq(messageFileUploadsTable.messId, messId),
      ),
    );
  return Number(usage?.total ?? 0);
};

const findFile = async (fileId: string) => {
  const [row] = await db
    .select()
    .from(messageFileUploadsTable)
    .where(eq(messageFileUploadsTable.fileId, fileId))
    .limit(1);
  return row ?? null;
};

const matchExisting = (
  existing: FileRow,
  messId: number,
  userId: number,
  attachment: MessageAttachment,
): Reservation =>
  existing.messId === messId &&
  existing.uploaderUserId === userId &&
  existing.sizeBytes === attachment.size &&
  existing.sha256 === attachment.sha256
    ? { ok: true, row: existing }
    : { ok: false, status: 400, error: "This file id is already in use" };

/** The day old usage rows were last trimmed, so it happens once a day. */
let lastTrimDate: string | null = null;

/**
 * Counts a file against its mess's daily limit, once: asking again for the
 * same file returns the row made the first time. With `wantStorage` the file
 * is also marked for R2 unless the global storage limit is reached.
 *
 * The database is a long round trip away, so the common cases are kept to as
 * few queries as possible: a file already counted costs one lookup, a new
 * one a single usage query inside the locked transaction.
 */
const reserveFile = async (
  messId: number,
  userId: number,
  attachment: MessageAttachment,
  wantStorage: boolean,
): Promise<Reservation> => {
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, status: 413, error: FILE_TOO_LARGE_ERROR };
  }
  const known = await findFile(attachment.id);
  if (known) return matchExisting(known, messId, userId, attachment);

  const today = dateInAppTimeZone(new Date());
  const result = await db.transaction(
    async (tx): Promise<Reservation | null> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RESERVATION_LOCK_KEY})`,
      );
      const table = messageFileUploadsTable;
      const [usage] = await tx
        .select({
          mess: sql<
            string | null
          >`sum(${table.sizeBytes}) filter (where ${table.messId} = ${messId})`,
          stored: sql<
            string | null
          >`sum(${table.sizeBytes}) filter (where ${table.stored})`,
        })
        .from(table)
        .where(eq(table.usageDate, today));
      if (Number(usage?.mess ?? 0) + attachment.size > MESS_DAILY_LIMIT_BYTES) {
        return { ok: false, status: 422, error: MESS_LIMIT_ERROR };
      }

      let stored = false;
      if (wantStorage && isR2Configured) {
        const globalUsed = Number(usage?.stored ?? 0);
        stored = globalUsed + attachment.size <= GLOBAL_DAILY_STORAGE_BYTES;
        if (!stored) {
          logger.warn(
            { globalUsed, limit: GLOBAL_DAILY_STORAGE_BYTES },
            "R2 global daily storage limit reached; chat files fall back to phone-to-phone",
          );
        } else if (
          globalUsed < GLOBAL_WARNING_BYTES &&
          globalUsed + attachment.size >= GLOBAL_WARNING_BYTES
        ) {
          logger.warn(
            {
              globalUsed: globalUsed + attachment.size,
              limit: GLOBAL_DAILY_STORAGE_BYTES,
            },
            "R2 daily chat file storage passed 80% of the global limit",
          );
        }
      }

      const [row] = await tx
        .insert(table)
        .values({
          fileId: attachment.id,
          messId,
          uploaderUserId: userId,
          sizeBytes: attachment.size,
          sha256: attachment.sha256,
          usageDate: today,
          stored,
          expiresAt: new Date(Date.now() + R2_FILE_RETENTION_DAYS * ONE_DAY_MS),
        })
        // The same file counted by a concurrent request is looked up below.
        .onConflictDoNothing()
        .returning();
      return row ? { ok: true, row } : null;
    },
  );
  if (result === null) {
    const raced = await findFile(attachment.id);
    return raced
      ? matchExisting(raced, messId, userId, attachment)
      : { ok: false, status: 400, error: "This file id is already in use" };
  }

  // Old usage rows are only history; trimming them once a day is plenty.
  if (result.ok && lastTrimDate !== today) {
    lastTrimDate = today;
    void db
      .delete(messageFileUploadsTable)
      .where(
        lt(
          messageFileUploadsTable.usageDate,
          dateInAppTimeZone(
            new Date(Date.now() - USAGE_ROWS_KEPT_DAYS * ONE_DAY_MS),
          ),
        ),
      )
      .catch((error: unknown) =>
        logger.warn({ err: error }, "Could not trim old chat file usage"),
      );
  }
  return result;
};

/**
 * GET /mess/messages/file-quota?messId=
 * Today's file usage of the mess, so the app can refuse a file before
 * preparing it.
 */
export const getFileQuota = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  res.json({
    usedBytes: await usedToday(
      db,
      dateInAppTimeZone(new Date()),
      access.messId,
    ),
    limitBytes: MESS_DAILY_LIMIT_BYTES,
    maxFileBytes: MAX_ATTACHMENT_BYTES,
  });
};

/**
 * POST /mess/messages/file-upload
 * Counts the file against today's limit and answers
 * `{ storage: "cloud", uploadUrl }` when the phone may put it in R2, or
 * `{ storage: "relay" }` when it is shared phone to phone only. 413 and 422
 * mean the file may not be sent at all.
 */
export const requestFileUpload = async (req: AuthedRequest, res: Response) => {
  const attachment = parseMessageAttachment(req.body?.attachment);
  if (!attachment) {
    res.status(400).json({ error: "The attached file description is invalid" });
    return;
  }
  const access = await resolveMessAccess(req.auth!.userId, req.body?.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const reservation = await reserveFile(
    access.messId,
    req.auth!.userId,
    attachment,
    true,
  );
  if (!reservation.ok) {
    res.status(reservation.status).json({ error: reservation.error });
    return;
  }
  const { row } = reservation;
  if (!row.stored || row.expiresAt.getTime() <= Date.now()) {
    res.json({ storage: "relay" });
    return;
  }
  res.json({
    storage: "cloud",
    uploadUrl: presignR2Url({
      method: "PUT",
      key: objectKey(access.messId, attachment.id),
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      headers: { "content-length": String(attachment.size) },
    }),
    storedUntil: row.expiresAt.toISOString(),
  });
};

/**
 * Checks a new message's file against the limits and, when its sender says
 * the upload it was allowed finished (`uploadConfirmed`), adds `storedUntil`.
 * The object is not looked up in R2 here: that cost a round trip on every
 * file message, and a false claim only makes that mess's members fall back
 * to phone to phone when the download finds nothing. Files from app builds
 * that never ask first are counted here. A storage problem never blocks a
 * message: the file is then shared phone to phone.
 */
export const prepareMessageAttachment = async (
  messId: number,
  userId: number,
  attachment: MessageAttachment | null,
  uploadConfirmed: boolean,
): Promise<
  | { ok: true; attachment: MessageAttachment | null }
  | { ok: false; status: 400 | 413 | 422; error: string }
> => {
  if (!attachment) return { ok: true, attachment };
  let row: FileRow;
  try {
    const reservation = await reserveFile(messId, userId, attachment, false);
    if (!reservation.ok) return reservation;
    row = reservation.row;
  } catch (error) {
    // For example the migration has not run yet: keep messages flowing.
    logger.error({ err: error }, "Could not count a chat file");
    return { ok: true, attachment };
  }
  if (
    !uploadConfirmed ||
    !row.stored ||
    row.expiresAt.getTime() <= Date.now()
  ) {
    return { ok: true, attachment };
  }
  return {
    ok: true,
    attachment: { ...attachment, storedUntil: row.expiresAt.toISOString() },
  };
};

/**
 * GET /mess/messages/file-url?messId=&messageId=
 * A short-lived download link for a file still kept in R2. 410 means it is
 * not there (any more), so the phone asks other members' phones instead.
 */
export const getFileDownloadUrl = async (req: AuthedRequest, res: Response) => {
  const access = await resolveMessAccess(req.auth!.userId, req.query.messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const messageId = parsePositiveInteger(req.query.messageId);
  if (!messageId) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }
  const [message] = await db
    .select({ attachment: messagesTable.attachment })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.id, messageId),
        eq(messagesTable.messId, access.messId),
      ),
    )
    .limit(1);
  const attachment = message?.attachment;
  if (!attachment) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const storedUntil = attachment.storedUntil
    ? new Date(attachment.storedUntil).getTime()
    : 0;
  if (!isR2Configured || !(storedUntil > Date.now())) {
    res.status(410).json({ error: "The file is no longer stored" });
    return;
  }
  res.json({
    url: presignR2Url({
      method: "GET",
      key: objectKey(access.messId, attachment.id),
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    }),
  });
};
