import crypto from "crypto";

export const generateMessKey = (): string =>
  crypto.randomBytes(4).toString("hex").toUpperCase();

export const generateTemporaryPassword = (): string =>
  crypto.randomBytes(9).toString("base64url").slice(0, 12);

export const toMessResponse = (mess: {
  id: number;
  name: string;
  messKey: string;
}) => ({
  id: mess.id,
  name: mess.name,
  messKey: mess.messKey,
});
