import { eq } from "drizzle-orm";

import {
  bazarItemsTable,
  consumersTable,
  db,
  depositEntriesTable,
  depositsTable,
  expenseDaysTable,
  mealControlHelperTable,
  mealControlTable,
  mealOptOutsTable,
  mealsTable,
  memberRequestsTable,
  messesTable,
  noticesTable,
  notificationsTable,
} from "../db/dbConfig.js";

// Permanently deletes a mess and every row scoped to it. Child tables that
// reference messesTable without ON DELETE CASCADE (see db/schema/index.ts)
// must be cleared before the mess row itself, in dependency order — consumer
// history first (meals/deposits/opt-outs reference consumerId), then the
// consumers, then the remaining mess-scoped tables. Tables with an existing
// cascade (messages, notice/message read states, sync changes, bazar
// assignments via consumerId, etc.) are cleaned up automatically by Postgres.
export const deleteMessAndAllData = async (messId: number): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx
      .delete(mealOptOutsTable)
      .where(eq(mealOptOutsTable.messId, messId));
    await tx
      .delete(depositEntriesTable)
      .where(eq(depositEntriesTable.messId, messId));
    await tx.delete(depositsTable).where(eq(depositsTable.messId, messId));
    await tx.delete(mealsTable).where(eq(mealsTable.messId, messId));
    // Cascades bazar_assignments rows via their consumerId foreign key.
    await tx.delete(consumersTable).where(eq(consumersTable.messId, messId));

    await tx
      .delete(notificationsTable)
      .where(eq(notificationsTable.messId, messId));
    await tx.delete(noticesTable).where(eq(noticesTable.messId, messId));
    await tx
      .delete(bazarItemsTable)
      .where(eq(bazarItemsTable.messId, messId));
    await tx
      .delete(expenseDaysTable)
      .where(eq(expenseDaysTable.messId, messId));
    await tx
      .delete(memberRequestsTable)
      .where(eq(memberRequestsTable.messId, messId));
    await tx
      .delete(mealControlTable)
      .where(eq(mealControlTable.messId, messId));
    await tx
      .delete(mealControlHelperTable)
      .where(eq(mealControlHelperTable.messId, messId));

    await tx.delete(messesTable).where(eq(messesTable.id, messId));
  });
};
