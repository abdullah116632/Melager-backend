import { randomInt, timingSafeEqual } from "node:crypto";

const OTP_TTL_MS = 10 * 60 * 1000;

type PublicAuthUserInput = {
  id: number;
  email: string;
  name: string;
  mobileNumber: string | null;
  googleSubject: string | null;
};

export const normalizeEmail = (email: string): string =>
  email.toLowerCase().trim();

const EMAIL_LOCAL_PART_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
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

// Private on purpose: every OTP check must go through otpMatches so none of
// them fall back to a short-circuiting === comparison.
const normalizeOtp = (otp: string): string => otp.trim();

// Math.random() is a seeded PRNG whose internal state can be recovered from a
// handful of outputs, which would let an attacker predict the next account's
// code. Every OTP guards a password reset, an email change or an account
// deletion, so the generator has to be the cryptographic one.
export const createOtpChallenge = (): { otp: string; expiresAt: Date } => ({
  otp: randomInt(100000, 1000000).toString(),
  expiresAt: new Date(Date.now() + OTP_TTL_MS),
});

/**
 * Constant-time OTP comparison so a wrong code leaks no prefix information.
 * `supplied` comes straight off the request body, so it is coerced rather than
 * trusted to be a string — a JSON number used to throw here.
 */
export const otpMatches = (stored: string, supplied: unknown): boolean => {
  const storedBytes = Buffer.from(stored, "utf8");
  const suppliedBytes = Buffer.from(
    normalizeOtp(String(supplied ?? "")),
    "utf8",
  );
  return (
    storedBytes.length === suppliedBytes.length &&
    timingSafeEqual(storedBytes, suppliedBytes)
  );
};

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
  hasGoogleAccount: user.googleSubject != null,
});
