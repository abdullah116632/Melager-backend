import { Router } from "express";
import { eq, and, gte, lt } from "drizzle-orm";
import {
  db,
  consumersTable,
  depositEntriesTable,
} from "../../db/index.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getMessContext } from "../lib/mess-access.js";

const router = Router();

// POST /api/mess/deposit-entry — admin adds a deposit for a consumer
router.post("/mess/deposit-entry", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const { messId: messIdRaw, consumerId: consumerIdRaw, amount: amountRaw, depositedAt: depositedAtRaw, note } = req.body ?? {};

  const messId = parseInt(messIdRaw, 10);
  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }

  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const consumerId = parseInt(consumerIdRaw, 10);
  if (!consumerId || isNaN(consumerId)) {
    res.status(400).json({ error: "consumerId is required" });
    return;
  }

  const amount = parseInt(amountRaw, 10);
  if (!amount || isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const [consumer] = await db
    .select({ id: consumersTable.id })
    .from(consumersTable)
    .where(and(eq(consumersTable.id, consumerId), eq(consumersTable.messId, messId)))
    .limit(1);
  if (!consumer) {
    res.status(404).json({ error: "Consumer not found in this mess" });
    return;
  }

  const depositedAt = depositedAtRaw ? new Date(depositedAtRaw) : new Date();
  if (isNaN(depositedAt.getTime())) {
    res.status(400).json({ error: "Invalid depositedAt date" });
    return;
  }

  const [entry] = await db
    .insert(depositEntriesTable)
    .values({ messId, consumerId, amount, depositedAt, note: note ?? null })
    .returning();

  res.status(201).json({
    entry: {
      id: entry.id,
      consumerId: entry.consumerId,
      amount: entry.amount,
      depositedAt: entry.depositedAt.toISOString(),
      note: entry.note,
    },
  });
});

// GET /api/mess/deposit-entries?messId=X&yearMonth=YYYY-MM
router.get("/mess/deposit-entries", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const messId = parseInt(req.query.messId as string, 10);
  const yearMonth = req.query.yearMonth as string;

  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    res.status(400).json({ error: "yearMonth must be YYYY-MM" });
    return;
  }

  const { mess } = await getMessContext(userId, messId);
  if (!mess) {
    res.status(403).json({ error: "Access denied" });
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

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      consumerId: e.consumerId,
      amount: e.amount,
      depositedAt: e.depositedAt.toISOString(),
      note: e.note,
    })),
  });
});

// DELETE /api/mess/deposit-entry/:id?messId=X
router.delete("/mess/deposit-entry/:id", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const entryId = parseInt(String(req.params.id), 10);
  const messId = parseInt(String(req.query.messId), 10);

  if (!messId || isNaN(messId)) {
    res.status(400).json({ error: "messId is required" });
    return;
  }
  if (!entryId || isNaN(entryId)) {
    res.status(400).json({ error: "entry id is required" });
    return;
  }

  const { mess, role } = await getMessContext(userId, messId);
  if (!mess || role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const [entry] = await db
    .select({ id: depositEntriesTable.id })
    .from(depositEntriesTable)
    .where(and(eq(depositEntriesTable.id, entryId), eq(depositEntriesTable.messId, messId)))
    .limit(1);
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  await db.delete(depositEntriesTable).where(eq(depositEntriesTable.id, entryId));
  res.json({ success: true });
});

export default router;
