import type { Response } from "express";
import { eq, and, gte, lt } from "drizzle-orm";
import { db, consumersTable, depositEntriesTable } from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { toDepositEntryResponse } from "../utils/depositEntryUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";

// POST /api/mess/deposit-entry — admin adds a deposit for a consumer
export const addDepositEntry = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const {
    messId: messIdRaw,
    consumerId: consumerIdRaw,
    amount: amountRaw,
    depositedAt: depositedAtRaw,
    note,
  } = req.body ?? {};

  const messId = parsePositiveInteger(messIdRaw);
  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }

  const access = await resolveMessAccess(userId, messId, { adminOnly: true });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const consumerId = parsePositiveInteger(consumerIdRaw);
  if (!consumerId) {
    res.status(400).json({ error: "consumerId is required" });
    return;
  }

  const amount = parsePositiveInteger(amountRaw);
  if (!amount) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const [consumer] = await db
    .select({ id: consumersTable.id })
    .from(consumersTable)
    .where(
      and(eq(consumersTable.id, consumerId), eq(consumersTable.messId, messId)),
    )
    .limit(1);
  if (!consumer) {
    res.status(404).json({ error: "Consumer not found in this mess" });
    return;
  }

  const depositedAt = depositedAtRaw ? new Date(depositedAtRaw) : new Date();
  if (Number.isNaN(depositedAt.getTime())) {
    res.status(400).json({ error: "Invalid depositedAt date" });
    return;
  }

  const [entry] = await db
    .insert(depositEntriesTable)
    .values({ messId, consumerId, amount, depositedAt, note: note ?? null })
    .returning();

  res.status(201).json({ entry: toDepositEntryResponse(entry) });
};

// GET /api/mess/deposit-entries?messId=X&yearMonth=YYYY-MM
export const getDepositEntries = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const messId = parsePositiveInteger(req.query.messId);
  const yearMonth = req.query.yearMonth as string;

  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    res.status(400).json({ error: "yearMonth must be YYYY-MM" });
    return;
  }

  const access = await resolveMessAccess(userId, messId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [year, month] = yearMonth.split("-").map(Number);
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  const entries = await db
    .select()
    .from(depositEntriesTable)
    .where(
      and(
        eq(depositEntriesTable.messId, messId),
        gte(depositEntriesTable.depositedAt, startDate),
        lt(depositEntriesTable.depositedAt, endDate),
      ),
    );

  res.json({ entries: entries.map(toDepositEntryResponse) });
};

// DELETE /api/mess/deposit-entry/:id?messId=X
export const deleteDepositEntry = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const entryId = parsePositiveInteger(req.params.id);
  const messId = parsePositiveInteger(req.query.messId);

  if (!messId) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!entryId) {
    res.status(400).json({ error: "entry id is required" });
    return;
  }

  const access = await resolveMessAccess(userId, messId, { adminOnly: true });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const [entry] = await db
    .select({ id: depositEntriesTable.id })
    .from(depositEntriesTable)
    .where(
      and(
        eq(depositEntriesTable.id, entryId),
        eq(depositEntriesTable.messId, messId),
      ),
    )
    .limit(1);
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  await db
    .delete(depositEntriesTable)
    .where(eq(depositEntriesTable.id, entryId));
  res.json({ success: true });
};
