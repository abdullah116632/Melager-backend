import { and, eq } from "drizzle-orm";

import { db, consumersTable, messesTable } from "../../db/index.js";

/**
 * Resolve a user's membership and role in one database round trip.
 * Most API routes call this before their real query, so keeping it to a
 * single joined lookup noticeably reduces latency with a remote database.
 */
export async function getMessContext(userId: number, messId: number) {
  const [row] = await db
    .select({
      id: messesTable.id,
      name: messesTable.name,
      messKey: messesTable.messKey,
      adminUserId: messesTable.adminUserId,
      createdAt: messesTable.createdAt,
      consumerId: consumersTable.id,
      consumerIsAdmin: consumersTable.isAdmin,
    })
    .from(messesTable)
    .leftJoin(
      consumersTable,
      and(
        eq(consumersTable.messId, messesTable.id),
        eq(consumersTable.userId, userId),
      ),
    )
    .where(eq(messesTable.id, messId))
    .limit(1);

  if (!row) {
    return { mess: null, role: null as "admin" | "member" | null, consumerId: null };
  }

  const isOwner = row.adminUserId === userId;
  if (!isOwner && row.consumerId == null) {
    return { mess: null, role: null as "admin" | "member" | null, consumerId: null };
  }

  const mess = {
    id: row.id,
    name: row.name,
    messKey: row.messKey,
    adminUserId: row.adminUserId,
    createdAt: row.createdAt,
  };
  const role: "admin" | "member" =
    isOwner || row.consumerIsAdmin ? "admin" : "member";

  return { mess, role, consumerId: row.consumerId };
}
