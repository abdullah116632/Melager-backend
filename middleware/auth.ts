import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { SESSION_SECRET } from "../lib/sessionSecret.js";

export interface AuthPayload {
  userId: number;
}

export interface AuthedRequest extends Request {
  auth?: { userId: number };
}

export function signToken(userId: number): string {
  return jwt.sign({ userId } as AuthPayload, SESSION_SECRET, {
    expiresIn: "30d",
  });
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), SESSION_SECRET) as AuthPayload;
    req.auth = { userId: payload.userId };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
