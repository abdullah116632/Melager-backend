import type { Response } from "express";
import { eq } from "drizzle-orm";

import { db, pushTokensTable } from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";

const isExpoPushToken = (value: string): boolean =>
  /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value);

export const registerPushToken = async (req: AuthedRequest, res: Response) => {
  const token = String(req.body?.token ?? "").trim();
  const platform = String(req.body?.platform ?? "unknown").trim();
  if (!isExpoPushToken(token) || !platform || platform.length > 32) {
    res.status(400).json({ error: "A valid Expo push token and platform are required" });
    return;
  }

  const existing = await db
    .select({ id: pushTokensTable.id })
    .from(pushTokensTable)
    .where(eq(pushTokensTable.token, token))
    .limit(1);
  if (existing[0]) {
    await db
      .update(pushTokensTable)
      .set({ userId: req.auth!.userId, platform, updatedAt: new Date() })
      .where(eq(pushTokensTable.id, existing[0].id));
  } else {
    await db.insert(pushTokensTable).values({
      userId: req.auth!.userId,
      token,
      platform,
    });
  }

  res.status(204).end();
};
