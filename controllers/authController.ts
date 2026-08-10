import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  messesTable,
  consumersTable,
  otpVerificationsTable,
  passwordResetsTable,
  memberRequestsTable,
} from "../db/dbConfig.js";
import { signToken, type AuthedRequest } from "../middleware/auth.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../lib/email.js";
import {
  createOtpChallenge,
  getConfiguredGoogleClientIds,
  isOtpExpired,
  normalizeEmail,
  normalizeOtp,
  toPublicAuthUser,
} from "../utils/authUtils.js";
import {
  hashPassword,
  isPasswordValid,
  verifyPassword,
} from "../utils/passwordUtils.js";

const googleClient = new OAuth2Client();

// POST /api/auth/signup — stores pending verification, sends OTP email
export const signup = async (req: Request, res: Response) => {
  const { email, name, password, mobileNumber } = req.body ?? {};
  if (!email || !name || !password) {
    res.status(400).json({ error: "email, name and password are required" });
    return;
  }
  if (mobileNumber && (mobileNumber as string).trim().length !== 11) {
    res.status(400).json({ error: "Mobile number must be exactly 11 digits" });
    return;
  }
  if (!isPasswordValid(password as string)) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);
  const normalizedMobile = mobileNumber
    ? (mobileNumber as string).trim()
    : undefined;
  const normalizedName = (name as string).trim();

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();
  const passwordHash = await hashPassword(password as string);

  await db
    .delete(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail));
  await db.insert(otpVerificationsTable).values({
    email: normalizedEmail,
    name: normalizedName,
    passwordHash,
    mobileNumber: normalizedMobile,
    otp,
    expiresAt,
  });

  try {
    await sendOtpEmail(normalizedEmail, normalizedName, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to send OTP email");
    res
      .status(500)
      .json({ error: "Failed to send verification email. Please try again." });
    return;
  }

  res.json({ message: "OTP sent", pendingEmail: normalizedEmail });
};

// POST /api/auth/verify-otp — verifies OTP, creates user, returns token
export const verifyOtp = async (req: Request, res: Response) => {
  const { email, otp } = req.body ?? {};
  if (!email || !otp) {
    res.status(400).json({ error: "email and otp are required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);

  const [pending] = await db
    .select()
    .from(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res
      .status(404)
      .json({ error: "No pending verification. Please sign up again." });
    return;
  }
  if (isOtpExpired(pending.expiresAt)) {
    await db
      .delete(otpVerificationsTable)
      .where(eq(otpVerificationsTable.email, normalizedEmail));
    res.status(410).json({ error: "Code expired. Please sign up again." });
    return;
  }
  if (pending.otp !== normalizeOtp(otp as string)) {
    res.status(401).json({ error: "Incorrect code. Please try again." });
    return;
  }

  const [user] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      name: pending.name,
      passwordHash: pending.passwordHash,
      mobileNumber: pending.mobileNumber ?? null,
    })
    .returning({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      mobileNumber: usersTable.mobileNumber,
    });

  await db
    .delete(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail));

  const token = signToken(user.id);
  res.json({ token, user });
};

// POST /api/auth/resend-otp — regenerates and resends OTP
export const resendOtp = async (req: Request, res: Response) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);

  const [pending] = await db
    .select()
    .from(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res
      .status(404)
      .json({ error: "No pending verification. Please sign up first." });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();

  await db
    .update(otpVerificationsTable)
    .set({ otp, expiresAt })
    .where(eq(otpVerificationsTable.email, normalizedEmail));

  try {
    await sendOtpEmail(normalizedEmail, pending.name, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to resend OTP email");
    res.status(500).json({ error: "Failed to send email. Please try again." });
    return;
  }

  res.json({ message: "OTP resent" });
};

// POST /api/auth/forgot-password — sends OTP reset code to registered email
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);

  const [user] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "No account found with this email address" });
    return;
  }

  const { otp, expiresAt } = createOtpChallenge();

  await db
    .delete(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail));
  await db
    .insert(passwordResetsTable)
    .values({ email: normalizedEmail, otp, expiresAt });

  try {
    await sendPasswordResetEmail(normalizedEmail, user.name, otp);
  } catch (err) {
    req.log.error({ err }, "Failed to send password reset email");
    res
      .status(500)
      .json({ error: "Failed to send reset email. Please try again." });
    return;
  }

  res.json({ message: "Reset code sent", pendingEmail: normalizedEmail });
};

// POST /api/auth/resend-reset-otp — resends password reset OTP
export const resendResetOtp = async (req: Request, res: Response) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);

  const [pending] = await db
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res
      .status(404)
      .json({ error: "No pending reset. Please request a new code." });
    return;
  }

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  const { otp, expiresAt } = createOtpChallenge();

  await db
    .update(passwordResetsTable)
    .set({ otp, expiresAt })
    .where(eq(passwordResetsTable.email, normalizedEmail));

  try {
    await sendPasswordResetEmail(normalizedEmail, user?.name ?? "User", otp);
  } catch (err) {
    req.log.error({ err }, "Failed to resend reset email");
    res.status(500).json({ error: "Failed to send email. Please try again." });
    return;
  }

  res.json({ message: "Reset code resent" });
};

// POST /api/auth/reset-password — verifies OTP and updates password
export const resetPassword = async (req: Request, res: Response) => {
  const { email, otp, newPassword } = req.body ?? {};
  if (!email || !otp || !newPassword) {
    res.status(400).json({ error: "email, otp and newPassword are required" });
    return;
  }
  if (!isPasswordValid(newPassword as string)) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const normalizedEmail = normalizeEmail(email as string);

  const [pending] = await db
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res
      .status(404)
      .json({ error: "No pending reset. Please request a new code." });
    return;
  }
  if (isOtpExpired(pending.expiresAt)) {
    await db
      .delete(passwordResetsTable)
      .where(eq(passwordResetsTable.email, normalizedEmail));
    res.status(410).json({ error: "Code expired. Please request a new one." });
    return;
  }
  if (pending.otp !== normalizeOtp(otp as string)) {
    res.status(401).json({ error: "Incorrect code. Please try again." });
    return;
  }

  const passwordHash = await hashPassword(newPassword as string);
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.email, normalizedEmail));

  await db
    .delete(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail));

  res.json({ message: "Password reset successfully" });
};

// POST /api/auth/login
export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizeEmail(email as string)))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const valid = await verifyPassword(password as string, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = signToken(user.id);
  res.json({ token, user: toPublicAuthUser(user) });
};

// POST /api/auth/google — verifies the Google ID token on the server, then
// signs in an existing account or creates a new verified account.
export const googleLogin = async (req: Request, res: Response) => {
  const { idToken } = req.body ?? {};
  if (!idToken || typeof idToken !== "string") {
    res.status(400).json({ error: "Google ID token is required" });
    return;
  }

  const audiences = getConfiguredGoogleClientIds();
  if (audiences.length === 0) {
    req.log.error("GOOGLE_CLIENT_IDS is not configured");
    res.status(503).json({ error: "Google sign-in is not configured yet" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: audiences,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      res
        .status(401)
        .json({ error: "Your Google account email could not be verified" });
      return;
    }

    const email = normalizeEmail(payload.email);
    let [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.googleSubject, payload.sub))
      .limit(1);

    if (!user) {
      const [emailUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);

      if (emailUser) {
        if (
          emailUser.googleSubject &&
          emailUser.googleSubject !== payload.sub
        ) {
          res.status(409).json({
            error: "This email is already linked to another Google account",
          });
          return;
        }
        [user] = await db
          .update(usersTable)
          .set({ googleSubject: payload.sub })
          .where(eq(usersTable.id, emailUser.id))
          .returning();
      } else {
        const fallbackName =
          payload.name?.trim() || email.split("@")[0] || "Google User";
        const passwordHash = await hashPassword(`google:${randomUUID()}`);
        [user] = await db
          .insert(usersTable)
          .values({
            email,
            name: fallbackName,
            passwordHash,
            googleSubject: payload.sub,
          })
          .returning();
      }
    }

    const token = signToken(user.id);
    res.json({
      token,
      user: toPublicAuthUser(user),
    });
  } catch (err) {
    req.log.warn({ err }, "Google ID token verification failed");
    res.status(401).json({ error: "Google sign-in could not be verified" });
  }
};

// GET /api/auth/me — returns all messes + all pending/rejected requests
export const me = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;

  // These datasets are independent. Fetch them in parallel and join the
  // membership/request names in SQL to avoid 4-6 sequential Neon round trips.
  const [userRows, adminMesses, memberships, requestRecords] =
    await Promise.all([
      db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          name: usersTable.name,
          mobileNumber: usersTable.mobileNumber,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1),
      db
        .select({
          id: messesTable.id,
          name: messesTable.name,
          messKey: messesTable.messKey,
        })
        .from(messesTable)
        .where(eq(messesTable.adminUserId, userId)),
      db
        .select({
          id: messesTable.id,
          name: messesTable.name,
          messKey: messesTable.messKey,
          isAdmin: consumersTable.isAdmin,
        })
        .from(consumersTable)
        .innerJoin(messesTable, eq(consumersTable.messId, messesTable.id))
        .where(eq(consumersTable.userId, userId)),
      db
        .select({
          id: memberRequestsTable.id,
          messId: memberRequestsTable.messId,
          messName: messesTable.name,
          status: memberRequestsTable.status,
        })
        .from(memberRequestsTable)
        .innerJoin(messesTable, eq(memberRequestsTable.messId, messesTable.id))
        .where(
          and(
            eq(memberRequestsTable.userId, userId),
            inArray(memberRequestsTable.status, ["pending", "rejected"]),
          ),
        ),
    ]);

  const user = userRows[0];
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const messMap = new Map<
    number,
    {
      id: number;
      name: string;
      messKey: string;
      role: "admin" | "member";
    }
  >();
  for (const mess of adminMesses) {
    messMap.set(mess.id, { ...mess, role: "admin" });
  }
  for (const membership of memberships) {
    if (!messMap.has(membership.id)) {
      messMap.set(membership.id, {
        id: membership.id,
        name: membership.name,
        messKey: membership.messKey,
        role: membership.isAdmin ? "admin" : "member",
      });
    }
  }

  const messes = [...messMap.values()];
  const requests = requestRecords.map((request) => ({
    id: request.id,
    messId: request.messId,
    messName: request.messName,
    status: request.status as "pending" | "rejected",
  }));

  res.json({ user, messes, requests });
};
