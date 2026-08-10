const OTP_TTL_MS = 10 * 60 * 1000;

type PublicAuthUserInput = {
  id: number;
  email: string;
  name: string;
  mobileNumber: string | null;
};

export const normalizeEmail = (email: string): string =>
  email.toLowerCase().trim();

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
