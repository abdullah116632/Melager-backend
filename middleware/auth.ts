import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const SECRET =
  process.env.SESSION_SECRET ?? "dev-secret-please-set-session-secret";

export interface AuthPayload {
  userId: number;
}

export interface AuthedRequest extends Request {
  auth?: { userId: number };
}

export function signToken(userId: number): string {
  return jwt.sign({ userId } as AuthPayload, SECRET, { expiresIn: "30d" });
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
    const payload = jwt.verify(header.slice(7), SECRET) as AuthPayload;
    req.auth = { userId: payload.userId };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
