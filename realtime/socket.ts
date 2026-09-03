import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";

import { getMessContext } from "../lib/mess-access.js";
import { logger } from "../lib/logger.js";
import type { AuthPayload } from "../middleware/auth.js";

const SESSION_SECRET =
  process.env.SESSION_SECRET ?? "dev-secret-please-set-session-secret";

type RealtimeSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  { userId: number; messId: number }
>;

export const messRoom = (messId: number): string => `mess:${messId}`;
let realtimeServer: Server | null = null;

/**
 * Creates the shared real-time server. Clients authenticate with the same JWT
 * used by the REST API and are admitted only to a mess they belong to.
 */
export const initializeRealtime = (httpServer: HttpServer): Server => {
  if (realtimeServer) return realtimeServer;

  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const rawMessId = socket.handshake.auth?.messId;
    const messId = Number(rawMessId);

    if (typeof token !== "string" || !Number.isInteger(messId) || messId <= 0) {
      next(new Error("Authentication and a valid messId are required"));
      return;
    }

    try {
      const payload = jwt.verify(token, SESSION_SECRET) as AuthPayload;
      const context = await getMessContext(payload.userId, messId);
      if (!context.mess) {
        next(new Error("Access denied"));
        return;
      }
      (socket as RealtimeSocket).data = { userId: payload.userId, messId };
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const realtimeSocket = socket as RealtimeSocket;
    realtimeSocket.join(messRoom(realtimeSocket.data.messId));
    logger.debug(
      { socketId: socket.id, userId: realtimeSocket.data.userId, messId: realtimeSocket.data.messId },
      "Realtime client connected",
    );

    socket.on("disconnect", (reason) => {
      logger.debug(
        { socketId: socket.id, userId: realtimeSocket.data.userId, messId: realtimeSocket.data.messId, reason },
        "Realtime client disconnected",
      );
    });
  });

  realtimeServer = io;
  return io;
};

/** Emit a future feature event only to members of one mess. */
export const emitToMess = (
  messId: number,
  event: string,
  payload: unknown,
): void => {
  realtimeServer?.to(messRoom(messId)).emit(event, payload);
};
