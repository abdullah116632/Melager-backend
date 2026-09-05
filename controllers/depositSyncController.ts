import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";

import {
  consumersTable,
  db,
  depositEntriesTable,
  syncClientMutationsTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { toDepositEntryResponse } from "../utils/depositEntryUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { emitToMess } from "../realtime/socket.js";

const syncError = (message: string, status: number) =>
  Object.assign(new Error(message), { status });

const normalizedNote = (value: unknown): string | null =>
  String(value ?? "").trim() || null;

const getYearMonth = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

export const syncDepositMutation = async (
  req: AuthedRequest,
  res: Response,
) => {
  const userId = req.auth!.userId;
  const clientMutationId = String(req.body?.clientMutationId ?? "");
  const operation = String(req.body?.operation ?? "");
  const payload = req.body?.payload ?? {};
  if (
    !clientMutationId ||
    !["create", "update", "delete"].includes(operation)
  ) {
    res.status(400).json({ error: "Invalid deposit sync operation" });
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
    .update(JSON.stringify({ operation, payload, messId: access.messId }))
    .digest("hex");

  try {
    const outcome = await db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(syncClientMutationsTable)
        .values({
          clientMutationId,
          userId,
          messId: access.messId,
          entityType: "deposit",
          entityId: String(
            payload.serverId ?? payload.localId ?? clientMutationId,
          ),
          operation:
            operation === "delete"
              ? "delete"
              : operation === "create"
                ? "create"
                : "update",
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
          throw syncError("Duplicate mutation conflict", 409);
        }
        return {
          result: previous.responseBody as Record<string, unknown>,
          changedMonths: [] as string[],
          replayed: true,
        };
      }

      const amount = Number(payload.amount);
      const depositedAt = new Date(String(payload.depositedAt));
      if (
        operation !== "delete" &&
        (!/^[-+]?\d+(?:\.\d{1,3})?$/.test(String(payload.amount ?? "")) ||
          !Number.isFinite(amount) ||
          amount === 0 ||
          Number.isNaN(depositedAt.getTime()))
      ) {
        throw syncError("Invalid deposit amount or date", 400);
      }

      let result: Record<string, unknown>;
      let changedMonths: string[];
      if (operation === "create") {
        const consumerId = parsePositiveInteger(payload.consumerId);
        if (!consumerId) throw syncError("Invalid consumer", 400);
        const [consumer] = await tx
          .select({ id: consumersTable.id })
          .from(consumersTable)
          .where(
            and(
              eq(consumersTable.id, consumerId),
              eq(consumersTable.messId, access.messId),
            ),
          )
          .limit(1);
        if (!consumer) {
          throw syncError("Consumer not found in this mess", 404);
        }
        const [entry] = await tx
          .insert(depositEntriesTable)
          .values({
            messId: access.messId,
            consumerId,
            amount,
            depositedAt,
            note: normalizedNote(payload.note),
          })
          .returning();
        result = { entry: toDepositEntryResponse(entry!) };
        changedMonths = [getYearMonth(depositedAt)];
      } else {
        const serverId = parsePositiveInteger(payload.serverId);
        if (!serverId) throw syncError("Missing deposit id", 400);
        const base = payload.base as
          | { amount?: unknown; depositedAt?: unknown; note?: unknown }
          | undefined;
        const baseDate = new Date(String(base?.depositedAt ?? ""));
        if (
          !base ||
          !Number.isFinite(Number(base.amount)) ||
          Number.isNaN(baseDate.getTime())
        ) {
          throw syncError("A valid deposit base snapshot is required", 400);
        }

        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${access.messId}, ${-serverId})`,
        );
        const [current] = await tx
          .select()
          .from(depositEntriesTable)
          .where(
            and(
              eq(depositEntriesTable.id, serverId),
              eq(depositEntriesTable.messId, access.messId),
            ),
          )
          .limit(1);
        if (!current) throw syncError("Deposit not found", 404);
        const currentResponse = toDepositEntryResponse(current);
        if (
          Number(currentResponse.amount) !== Number(base.amount) ||
          currentResponse.depositedAt !== baseDate.toISOString() ||
          normalizedNote(currentResponse.note) !== normalizedNote(base.note)
        ) {
          throw syncError("Deposit changed on another device", 409);
        }

        if (operation === "delete") {
          await tx
            .delete(depositEntriesTable)
            .where(
              and(
                eq(depositEntriesTable.id, serverId),
                eq(depositEntriesTable.messId, access.messId),
              ),
            );
          result = { success: true, serverId };
          changedMonths = [getYearMonth(baseDate)];
        } else {
          const [entry] = await tx
            .update(depositEntriesTable)
            .set({ amount, depositedAt, note: normalizedNote(payload.note) })
            .where(
              and(
                eq(depositEntriesTable.id, serverId),
                eq(depositEntriesTable.messId, access.messId),
              ),
            )
            .returning();
          result = { entry: toDepositEntryResponse(entry!) };
          changedMonths = [
            ...new Set([getYearMonth(baseDate), getYearMonth(depositedAt)]),
          ];
        }
      }

      await tx
        .update(syncClientMutationsTable)
        .set({
          responseStatus: 200,
          responseBody: result,
          completedAt: new Date(),
        })
        .where(eq(syncClientMutationsTable.id, receipt.id));
      return { result, changedMonths, replayed: false };
    });
    if (!outcome.replayed) {
      emitToMess(access.messId, "deposits:updated", {
        messId: access.messId,
        yearMonths: outcome.changedMonths,
        refreshEntries: true,
      });
    }
    res.json(outcome.result);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    throw error;
  }
};
