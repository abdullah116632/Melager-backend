import type { Response } from "express";
import { eq, and, gte, lt } from "drizzle-orm";
import { db, consumersTable, depositEntriesTable } from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { toDepositEntryResponse } from "../utils/depositEntryUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { emitToMess } from "../realtime/socket.js";

const getYearMonth = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

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

  const amount = Number(amountRaw);
  if (
    !Number.isFinite(amount) ||
    amount === 0 ||
    !/^[-+]?\d+(?:\.\d{1,3})?$/.test(String(amountRaw).trim())
  ) {
    res.status(400).json({
      error: "amount must be a non-zero number with up to 3 decimal places",
    });
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

  emitToMess(messId, "deposits:updated", {
    messId,
    yearMonths: [getYearMonth(depositedAt)],
    refreshEntries: true,
  });

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

// PATCH /api/mess/deposit-entry/:id — admin updates an existing deposit
export const updateDepositEntry = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const entryId = parsePositiveInteger(req.params.id);
  const {
    messId: messIdRaw,
    amount: amountRaw,
    depositedAt: depositedAtRaw,
    note,
  } = req.body ?? {};
  const messId = parsePositiveInteger(messIdRaw);
  if (!entryId || !messId) {
    res.status(400).json({ error: "entry id and messId are required" });
    return;
  }

  const access = await resolveMessAccess(userId, messId, { adminOnly: true });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const amount = Number(amountRaw);
  if (
    !Number.isFinite(amount) ||
    amount === 0 ||
    !/^[-+]?\d+(?:\.\d{1,3})?$/.test(String(amountRaw).trim())
  ) {
    res.status(400).json({
      error: "amount must be a non-zero number with up to 3 decimal places",
    });
    return;
  }
  const depositedAt = depositedAtRaw ? new Date(depositedAtRaw) : null;
  if (!depositedAt || Number.isNaN(depositedAt.getTime())) {
    res.status(400).json({ error: "Invalid depositedAt date" });
    return;
  }

  const [previousEntry] = await db
    .select({ depositedAt: depositEntriesTable.depositedAt })
    .from(depositEntriesTable)
    .where(
      and(
        eq(depositEntriesTable.id, entryId),
        eq(depositEntriesTable.messId, messId),
      ),
    )
    .limit(1);
  if (!previousEntry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  const [entry] = await db
    .update(depositEntriesTable)
    .set({ amount, depositedAt, note: note?.trim() || null })
    .where(
      and(
        eq(depositEntriesTable.id, entryId),
        eq(depositEntriesTable.messId, messId),
      ),
    )
    .returning();
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  emitToMess(messId, "deposits:updated", {
    messId,
    yearMonths: [
      ...new Set([
        getYearMonth(previousEntry.depositedAt),
        getYearMonth(depositedAt),
      ]),
    ],
    refreshEntries: true,
  });

  res.json({ entry: toDepositEntryResponse(entry) });
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
    .select({
      id: depositEntriesTable.id,
      depositedAt: depositEntriesTable.depositedAt,
    })
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
  emitToMess(messId, "deposits:updated", {
    messId,
    yearMonths: [getYearMonth(entry.depositedAt)],
    refreshEntries: true,
  });
  res.json({ success: true });
};
