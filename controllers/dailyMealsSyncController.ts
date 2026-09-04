import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";

import {
  db,
  syncChangesTable,
  syncClientMutationsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";

export const syncDailyMeal = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const clientMutationId = String(req.body?.clientMutationId ?? "");
  const payload = req.body?.payload ?? {};
  const yearMonth = String(payload.yearMonth ?? "");
  const consumerId = Number(payload.consumerId);
  const day = Number(payload.day);
  const countRaw = String(payload.count ?? "");
  const baseCountRaw = String(payload.baseCount ?? "");
  const count = Number(countRaw);
  const baseCount = Number(baseCountRaw);

  if (
    !clientMutationId ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth) ||
    !Number.isInteger(consumerId) ||
    !Number.isInteger(day) || day < 1 ||
    !/^\d+(?:\.\d{1,3})?$/.test(countRaw) ||
    !/^\d+(?:\.\d{1,3})?$/.test(baseCountRaw)
  ) {
    res.status(400).json({ error: "Invalid daily meal sync payload" });
    return;
  }

  const access = await resolveMessAccess(userId, req.body?.messId, {
    adminOnly: true,
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const requestHash = createHash("sha256")
    .update(JSON.stringify({ messId: access.messId, payload }))
    .digest("hex");

  try {
    const result = await db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(syncClientMutationsTable)
        .values({
          clientMutationId,
          userId,
          messId: access.messId,
          entityType: "daily_meal",
          entityId: `${yearMonth}:${consumerId}:${day}`,
          operation: "upsert",
          requestHash,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing()
        .returning();

      if (!receipt) {
        const [previous] = await tx
          .select()
          .from(syncClientMutationsTable)
          .where(
            and(
              eq(syncClientMutationsTable.userId, userId),
              eq(syncClientMutationsTable.clientMutationId, clientMutationId),
            ),
          )
          .limit(1);
        if (!previous?.completedAt || previous.requestHash !== requestHash) {
          throw Object.assign(new Error("Concurrent mutation conflict"), {
            status: 409,
          });
        }
        return previous.responseBody;
      }

      const write = await tx.execute(sql`
        INSERT INTO meals (mess_id, consumer_id, year_month, day, count)
        VALUES (${access.messId}, ${consumerId}, ${yearMonth}, ${day}, ${count})
        ON CONFLICT (mess_id, consumer_id, year_month, day) DO UPDATE
          SET count = EXCLUDED.count
          WHERE meals.count = ${baseCount}
        RETURNING count
      `);
      if (write.rows.length === 0) {
        throw Object.assign(new Error("Meal value changed by another device"), { status: 409 });
      }
      const body = { count };
      await tx.insert(syncChangesTable).values({
        messId: access.messId,
        actorUserId: userId,
        entityType: "daily_meal",
        entityId: `${yearMonth}:${consumerId}:${day}`,
        operation: "upsert",
        payload,
      });
      await tx
        .update(syncClientMutationsTable)
        .set({ responseStatus: 200, responseBody: body, completedAt: new Date() })
        .where(eq(syncClientMutationsTable.id, receipt.id));
      return body;
    });
    res.json(result);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    throw error;
  }
};
