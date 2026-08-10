import { getMessContext } from "../lib/mess-access.js";

type MessContext = Awaited<ReturnType<typeof getMessContext>>;

type MessAccessSuccess = {
  ok: true;
  messId: number;
  mess: NonNullable<MessContext["mess"]>;
  role: MessContext["role"];
  consumerId: MessContext["consumerId"];
};

type MessAccessFailure = {
  ok: false;
  status: 400 | 403;
  error: string;
};

export const resolveMessAccess = async (
  userId: number,
  rawMessId: unknown,
  options: {
    adminOnly?: boolean;
    missingMessIdError?: string;
  } = {},
): Promise<MessAccessSuccess | MessAccessFailure> => {
  const messId = Number.parseInt(String(rawMessId), 10);
  if (!Number.isInteger(messId) || messId <= 0) {
    return {
      ok: false,
      status: 400,
      error: options.missingMessIdError ?? "messId is required",
    };
  }

  const context = await getMessContext(userId, messId);
  if (!context.mess) {
    return {
      ok: false,
      status: 403,
      error: options.adminOnly ? "Admin access required" : "Access denied",
    };
  }
  if (options.adminOnly && context.role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  return {
    ok: true,
    messId,
    mess: context.mess,
    role: context.role,
    consumerId: context.consumerId,
  };
};
