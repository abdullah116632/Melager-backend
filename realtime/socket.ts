import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";

import { getMessContext } from "../lib/mess-access.js";
import { logger } from "../lib/logger.js";
import type { AuthPayload } from "../middleware/auth.js";

const SESSION_SECRET =
  process.env.SESSION_SECRET ?? "dev-secret-please-set-session-secret";

type RealtimeSocket = Socket<
  {
    "conversation:enter": (payload: { messId?: unknown }) => void;
    "conversation:leave": (payload: { messId?: unknown }) => void;
  },
  Record<string, never>,
  Record<string, never>,
  { userId: number; messId: number }
>;

export const messRoom = (messId: number): string => `mess:${messId}`;
export const userRoom = (userId: number): string => `user:${userId}`;
let realtimeServer: Server | null = null;
const conversationPresence = new Map<number, Map<number, Set<string>>>();

const updateConversationPresence = (
  socket: RealtimeSocket,
  present: boolean,
): void => {
  const { messId, userId } = socket.data;
  const messPresence = conversationPresence.get(messId);

  if (!present) {
    const userSockets = messPresence?.get(userId);
    userSockets?.delete(socket.id);
    if (userSockets?.size === 0) messPresence?.delete(userId);
    if (messPresence?.size === 0) conversationPresence.delete(messId);
    return;
  }

  const nextMessPresence = messPresence ?? new Map<number, Set<string>>();
  const userSockets = nextMessPresence.get(userId) ?? new Set<string>();
  userSockets.add(socket.id);
  nextMessPresence.set(userId, userSockets);
  conversationPresence.set(messId, nextMessPresence);
};

/** True while at least one connected device is viewing this mess conversation. */
export const isUserViewingConversation = (
  messId: number,
  userId: number,
): boolean => (conversationPresence.get(messId)?.get(userId)?.size ?? 0) > 0;

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
    realtimeSocket.join(userRoom(realtimeSocket.data.userId));
    realtimeSocket.on("conversation:enter", (payload) => {
      if (Number(payload?.messId) !== realtimeSocket.data.messId) return;
      updateConversationPresence(realtimeSocket, true);
    });
    realtimeSocket.on("conversation:leave", (payload) => {
      if (Number(payload?.messId) !== realtimeSocket.data.messId) return;
      updateConversationPresence(realtimeSocket, false);
    });
    logger.debug(
      {
        socketId: socket.id,
        userId: realtimeSocket.data.userId,
        messId: realtimeSocket.data.messId,
      },
      "Realtime client connected",
    );

    socket.on("disconnect", (reason) => {
      updateConversationPresence(realtimeSocket, false);
      logger.debug(
        {
          socketId: socket.id,
          userId: realtimeSocket.data.userId,
          messId: realtimeSocket.data.messId,
          reason,
        },
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

/** Emit a private event to every signed-in device belonging to one user. */
export const emitToUser = (
  userId: number,
  event: string,
  payload: unknown,
): void => {
  realtimeServer?.to(userRoom(userId)).emit(event, payload);
};
