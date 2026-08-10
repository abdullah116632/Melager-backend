import { and, eq } from "drizzle-orm";
import { db, messesTable } from "../db/dbConfig.js";
import { parsePositiveInteger } from "./numberUtils.js";

type PrimaryAdminAccessSuccess = {
  ok: true;
  messId: number;
  mess: typeof messesTable.$inferSelect;
};

type PrimaryAdminAccessFailure = {
  ok: false;
  status: 400 | 403;
  error: string;
};

export const resolvePrimaryAdminAccess = async (
  userId: number,
  rawMessId: unknown,
  options: {
    missingMessIdError?: string;
    accessDeniedError: string;
  },
): Promise<PrimaryAdminAccessSuccess | PrimaryAdminAccessFailure> => {
  const messId = parsePositiveInteger(rawMessId);
  if (!messId) {
    return {
      ok: false,
      status: 400,
      error: options.missingMessIdError ?? "messId is required",
    };
  }

  const [mess] = await db
    .select()
    .from(messesTable)
    .where(and(eq(messesTable.adminUserId, userId), eq(messesTable.id, messId)))
    .limit(1);

  if (!mess) {
    return { ok: false, status: 403, error: options.accessDeniedError };
  }

  return { ok: true, messId, mess };
};
