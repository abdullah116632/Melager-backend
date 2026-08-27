const OTP_TTL_MS = 10 * 60 * 1000;

type PublicAuthUserInput = {
  id: number;
  email: string;
  name: string;
  mobileNumber: string | null;
};

export const normalizeEmail = (email: string): string =>
  email.toLowerCase().trim();

const EMAIL_LOCAL_PART_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const EMAIL_DOMAIN_LABEL_PATTERN =
  /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
const EMAIL_TOP_LEVEL_DOMAIN_PATTERN = /^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i;

export const isValidEmail = (value: unknown): value is string => {
  if (typeof value !== "string") return false;

  const email = normalizeEmail(value);
  if (!email || email.length > 254) return false;

  const parts = email.split("@");
  if (parts.length !== 2) return false;

  const [localPart, domain] = parts;
  if (
    localPart.length === 0 ||
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  const domainLabels = domain.split(".");
  return (
    EMAIL_LOCAL_PART_PATTERN.test(localPart) &&
    domainLabels.length >= 2 &&
    domainLabels.every((label) => EMAIL_DOMAIN_LABEL_PATTERN.test(label)) &&
    EMAIL_TOP_LEVEL_DOMAIN_PATTERN.test(domainLabels.at(-1) ?? "")
  );
};

export const normalizeOtp = (otp: string): string => otp.trim();

export const createOtpChallenge = (): { otp: string; expiresAt: Date } => ({
  otp: Math.floor(100000 + Math.random() * 900000).toString(),
  expiresAt: new Date(Date.now() + OTP_TTL_MS),
});

export const isOtpExpired = (expiresAt: Date): boolean =>
  Date.now() > expiresAt.getTime();

export const getConfiguredGoogleClientIds = (): string[] =>
  (process.env.GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((clientId) => clientId.trim())
    .filter(Boolean);

export const toPublicAuthUser = (user: PublicAuthUserInput) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  mobileNumber: user.mobileNumber,
});
