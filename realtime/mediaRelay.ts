import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Server, Socket } from "socket.io";

import { db, messagesTable } from "../db/dbConfig.js";
import { logger } from "../lib/logger.js";

/**
 * Phone-to-phone file relay for chat attachments.
 *
 * The server never keeps a file. A member missing one asks for it, every
 * other online member whose phone still has it is asked whether it can send
 * it, the first to answer streams it in chunks, and each chunk is passed
 * straight to the asking socket and acknowledged end to end. Nothing is
 * buffered beyond the chunk in flight, so if nobody holding the file is
 * online the request simply waits until someone who has it connects.
 *
 * Only sockets that announce `mediaRelay` in their handshake take part, so
 * older app builds never see any of these events.
 */

const OFFER_WINDOW_MS = 8_000;
const CHUNK_FORWARD_TIMEOUT_MS = 30_000;
const TRANSFER_IDLE_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;
/** Base64 of a 256 KiB chunk is ~350 KB; leave headroom under the socket limit. */
const MAX_CHUNK_CHARS = 400_000;
const MAX_TRANSFERS_PER_SOCKET = 3;
const MAX_TRANSFERS = 500;

export const mediaRoom = (messId: number): string => `media:${messId}`;

interface Transfer {
  id: string;
  messId: number;
  fileId: string;
  size: number;
  requesterSocketId: string;
  requesterUserId: number;
  holderSocketId: string | null;
  nextSeq: number;
  lastActivity: number;
  offerTimer: ReturnType<typeof setTimeout> | null;
}

type Ack = (response: Record<string, unknown>) => void;

const transfers = new Map<string, Transfer>();
/** messId -> fileId -> sockets that asked while nobody holding it was online. */
const waiting = new Map<number, Map<string, Set<string>>>();

const isTransferId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64;

const safeAck = (ack: unknown): Ack =>
  typeof ack === "function" ? (ack as Ack) : () => undefined;

const addWaiting = (messId: number, fileId: string, socketId: string) => {
  const byFile = waiting.get(messId) ?? new Map<string, Set<string>>();
  const sockets = byFile.get(fileId) ?? new Set<string>();
  sockets.add(socketId);
  byFile.set(fileId, sockets);
  waiting.set(messId, byFile);
};

const removeWaitingSocket = (socketId: string) => {
  for (const [messId, byFile] of waiting) {
    for (const [fileId, sockets] of byFile) {
      sockets.delete(socketId);
      if (sockets.size === 0) byFile.delete(fileId);
    }
    if (byFile.size === 0) waiting.delete(messId);
  }
};

const endTransfer = (transfer: Transfer) => {
  if (transfer.offerTimer) clearTimeout(transfer.offerTimer);
  transfers.delete(transfer.id);
};

/**
 * Tells sockets waiting on files that a possible source just appeared, so
 * they ask again instead of polling. `fileId` narrows it to one file, used
 * when a download finishes and the downloader becomes a source itself.
 */
const wakeWaiting = (io: Server, messId: number, fileId?: string) => {
  const byFile = waiting.get(messId);
  if (!byFile) return;
  const entries = fileId
    ? ([[fileId, byFile.get(fileId)]] as const)
    : [...byFile.entries()];
  for (const [id, sockets] of entries) {
    if (!sockets) continue;
    for (const socketId of sockets) {
      io.to(socketId).emit("media:retry", { fileId: id });
    }
    byFile.delete(id);
  }
  if (byFile.size === 0) waiting.delete(messId);
};

const failTransfer = (io: Server, transfer: Transfer, reason: string) => {
  endTransfer(transfer);
  io.to(transfer.requesterSocketId).emit("media:failed", {
    transferId: transfer.id,
    fileId: transfer.fileId,
    reason,
  });
  if (transfer.holderSocketId) {
    io.to(transfer.holderSocketId).emit("media:cancel", {
      transferId: transfer.id,
    });
  }
};

let sweeper: ReturnType<typeof setInterval> | null = null;

const startSweeper = (io: Server) => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const transfer of transfers.values()) {
      if (now - transfer.lastActivity > TRANSFER_IDLE_MS) {
        failTransfer(io, transfer, "timeout");
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
};

export const registerMediaRelay = (
  io: Server,
  socket: Socket,
  context: { userId: number; messId: number },
): void => {
  startSweeper(io);
  const { userId, messId } = context;
  socket.join(mediaRoom(messId));
  // A new source may hold what others are waiting for.
  wakeWaiting(io, messId);

  socket.on("media:request", async (payload: unknown, rawAck: unknown) => {
    const ack = safeAck(rawAck);
    try {
      const messageId = Number((payload as { messageId?: unknown })?.messageId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        ack({ ok: false, error: "invalid" });
        return;
      }
      let ownActive = 0;
      for (const transfer of transfers.values()) {
        if (transfer.requesterSocketId === socket.id) ownActive += 1;
      }
      if (
        ownActive >= MAX_TRANSFERS_PER_SOCKET ||
        transfers.size >= MAX_TRANSFERS
      ) {
        ack({ ok: false, error: "busy" });
        return;
      }
      // The file is looked up through a message of this socket's own mess, so
      // a member can only ever fetch files shared in their mess.
      const [message] = await db
        .select({ attachment: messagesTable.attachment })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.id, messageId),
            eq(messagesTable.messId, messId),
          ),
        )
        .limit(1);
      const attachment = message?.attachment;
      if (!attachment) {
        ack({ ok: false, error: "not_found" });
        return;
      }

      const transfer: Transfer = {
        id: randomUUID(),
        messId,
        fileId: attachment.id,
        size: attachment.size,
        requesterSocketId: socket.id,
        requesterUserId: userId,
        holderSocketId: null,
        nextSeq: 0,
        lastActivity: Date.now(),
        offerTimer: null,
      };
      transfers.set(transfer.id, transfer);
      transfer.offerTimer = setTimeout(() => {
        transfer.offerTimer = null;
        if (transfer.holderSocketId || !transfers.has(transfer.id)) return;
        endTransfer(transfer);
        addWaiting(messId, transfer.fileId, socket.id);
        socket.emit("media:unavailable", {
          transferId: transfer.id,
          fileId: transfer.fileId,
        });
      }, OFFER_WINDOW_MS);

      ack({ ok: true, transferId: transfer.id, fileId: transfer.fileId });
      socket.to(mediaRoom(messId)).emit("media:query", {
        transferId: transfer.id,
        fileId: transfer.fileId,
      });
    } catch (error) {
      logger.warn({ err: error }, "Media request failed");
      ack({ ok: false, error: "server" });
    }
  });

  socket.on("media:offer", (payload: unknown, rawAck: unknown) => {
    const ack = safeAck(rawAck);
    const transferId = (payload as { transferId?: unknown })?.transferId;
    const transfer = isTransferId(transferId)
      ? transfers.get(transferId)
      : undefined;
    if (
      !transfer ||
      transfer.messId !== messId ||
      transfer.holderSocketId ||
      transfer.requesterSocketId === socket.id
    ) {
      ack({ accepted: false });
      return;
    }
    transfer.holderSocketId = socket.id;
    transfer.lastActivity = Date.now();
    if (transfer.offerTimer) clearTimeout(transfer.offerTimer);
    transfer.offerTimer = null;
    io.to(transfer.requesterSocketId).emit("media:start", {
      transferId: transfer.id,
      fileId: transfer.fileId,
      size: transfer.size,
    });
    ack({ accepted: true });
  });

  socket.on("media:chunk", (payload: unknown, rawAck: unknown) => {
    const ack = safeAck(rawAck);
    const chunk = payload as {
      transferId?: unknown;
      seq?: unknown;
      data?: unknown;
      final?: unknown;
    };
    const transfer = isTransferId(chunk?.transferId)
      ? transfers.get(chunk.transferId)
      : undefined;
    if (!transfer || transfer.holderSocketId !== socket.id) {
      ack({ ok: false, cancel: true });
      return;
    }
    if (
      chunk.seq !== transfer.nextSeq ||
      typeof chunk.data !== "string" ||
      chunk.data.length > MAX_CHUNK_CHARS
    ) {
      failTransfer(io, transfer, "bad_chunk");
      ack({ ok: false, cancel: true });
      return;
    }
    transfer.nextSeq += 1;
    transfer.lastActivity = Date.now();
    const requester = io.sockets.sockets.get(transfer.requesterSocketId);
    if (!requester) {
      failTransfer(io, transfer, "requester_gone");
      ack({ ok: false, cancel: true });
      return;
    }
    requester.timeout(CHUNK_FORWARD_TIMEOUT_MS).emit(
      "media:chunk",
      {
        transferId: transfer.id,
        seq: chunk.seq,
        data: chunk.data,
        final: chunk.final === true,
      },
      (error: unknown, response: unknown) => {
        if (!transfers.has(transfer.id)) {
          ack({ ok: false, cancel: true });
          return;
        }
        transfer.lastActivity = Date.now();
        const accepted =
          !error && (response as { ok?: unknown } | undefined)?.ok === true;
        if (!accepted) {
          failTransfer(io, transfer, error ? "requester_timeout" : "rejected");
          ack({ ok: false, cancel: true });
          return;
        }
        ack({ ok: true });
      },
    );
  });

  // The holder gave up, for example because its copy vanished mid-read.
  socket.on("media:abort", (payload: unknown) => {
    const transferId = (payload as { transferId?: unknown })?.transferId;
    const transfer = isTransferId(transferId)
      ? transfers.get(transferId)
      : undefined;
    if (!transfer) return;
    if (transfer.holderSocketId === socket.id) {
      failTransfer(io, transfer, "holder_aborted");
    } else if (transfer.requesterSocketId === socket.id) {
      failTransfer(io, transfer, "cancelled");
    }
  });

  // The requester stored and verified the file, so it can now serve it too.
  socket.on("media:complete", (payload: unknown) => {
    const transferId = (payload as { transferId?: unknown })?.transferId;
    const transfer = isTransferId(transferId)
      ? transfers.get(transferId)
      : undefined;
    if (!transfer || transfer.requesterSocketId !== socket.id) return;
    endTransfer(transfer);
    wakeWaiting(io, messId, transfer.fileId);
  });

  socket.on("disconnect", () => {
    removeWaitingSocket(socket.id);
    for (const transfer of [...transfers.values()]) {
      if (transfer.requesterSocketId === socket.id) {
        endTransfer(transfer);
        if (transfer.holderSocketId) {
          io.to(transfer.holderSocketId).emit("media:cancel", {
            transferId: transfer.id,
          });
        }
      } else if (transfer.holderSocketId === socket.id) {
        failTransfer(io, transfer, "holder_gone");
      }
    }
  });
};
