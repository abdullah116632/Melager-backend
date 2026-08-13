import { and, eq, ne, sql } from "drizzle-orm";

import {
  accountDeletionOtpsTable,
  consumersTable,
  db,
  memberRequestsTable,
  messesTable,
  otpVerificationsTable,
  passwordResetsTable,
  securityOtpsTable,
  usersTable,
} from "../db/dbConfig.js";

export const deleteUserAccountPreservingAccounting = async (
  userId: number,
  email: string,
) =>
  db.transaction(async (tx) => {
    const primaryMesses = await tx
      .select({ id: messesTable.id, name: messesTable.name })
      .from(messesTable)
      .where(eq(messesTable.adminUserId, userId));

    const replacements: Array<{ messId: number; userId: number }> = [];
    const blockedMessNames: string[] = [];

    for (const mess of primaryMesses) {
      const [replacement] = await tx
        .select({ userId: consumersTable.userId })
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.messId, mess.id),
            eq(consumersTable.isAdmin, true),
            ne(consumersTable.userId, userId),
          ),
        )
        .orderBy(consumersTable.id)
        .limit(1);

      if (!replacement?.userId) {
        blockedMessNames.push(mess.name);
      } else {
        replacements.push({ messId: mess.id, userId: replacement.userId });
      }
    }

    if (blockedMessNames.length > 0) return { blockedMessNames };

    for (const replacement of replacements) {
      await tx
        .update(messesTable)
        .set({ adminUserId: replacement.userId })
        .where(eq(messesTable.id, replacement.messId));
    }

    await tx
      .update(consumersTable)
      .set({
        name: sql<string>`${consumersTable.name} || ' (Account deleted)'`,
        userId: null,
        isAdmin: false,
        accountDeletedAt: new Date(),
      })
      .where(eq(consumersTable.userId, userId));

    await tx
      .delete(memberRequestsTable)
      .where(eq(memberRequestsTable.userId, userId));
    await tx
      .delete(securityOtpsTable)
      .where(eq(securityOtpsTable.userId, userId));
    await tx
      .delete(passwordResetsTable)
      .where(eq(passwordResetsTable.email, email));
    await tx
      .delete(otpVerificationsTable)
      .where(eq(otpVerificationsTable.email, email));
    await tx
      .delete(accountDeletionOtpsTable)
      .where(eq(accountDeletionOtpsTable.email, email));
    await tx.delete(usersTable).where(eq(usersTable.id, userId));

    return { blockedMessNames: [] as string[] };
  });
