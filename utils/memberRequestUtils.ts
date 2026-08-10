import { and, eq } from "drizzle-orm";
import { db, memberRequestsTable } from "../db/dbConfig.js";

export const getPendingMemberRequest = async (requestId: number) => {
  const [memberRequest] = await db
    .select()
    .from(memberRequestsTable)
    .where(
      and(
        eq(memberRequestsTable.id, requestId),
        eq(memberRequestsTable.status, "pending"),
      ),
    )
    .limit(1);

  return memberRequest ?? null;
};

export const updateMemberRequestStatus = async (
  requestId: number,
  status: "pending" | "accepted" | "rejected",
) => {
  await db
    .update(memberRequestsTable)
    .set({ status })
    .where(eq(memberRequestsTable.id, requestId));
};

export const toPendingRequestResponse = (
  requestId: number,
  mess: { id: number; name: string },
) => ({
  id: requestId,
  messId: mess.id,
  messName: mess.name,
  status: "pending" as const,
});
