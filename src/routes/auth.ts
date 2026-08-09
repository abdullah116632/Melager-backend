import { Router } from "express";
import bcrypt from "bcryptjs";
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
} from "../../db/index.js";
import { signToken, requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../lib/email.js";

const router = Router();
const googleClient = new OAuth2Client();

function configuredGoogleClientIds(): string[] {
  return (process.env.GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((clientId) => clientId.trim())
    .filter(Boolean);
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/signup — stores pending verification, sends OTP email
router.post("/auth/signup", async (req, res) => {
  const { email, name, password, mobileNumber } = req.body ?? {};
  if (!email || !name || !password) {
    res.status(400).json({ error: "email, name and password are required" });
    return;
  }
  if (mobileNumber && (mobileNumber as string).trim().length !== 11) {
    res.status(400).json({ error: "Mobile number must be exactly 11 digits" });
    return;
  }
  if ((password as string).length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();
  const normalizedMobile = mobileNumber ? (mobileNumber as string).trim() : undefined;

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const otp = generateOtp();
  const passwordHash = await bcrypt.hash(password, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await db
    .delete(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail));
  await db.insert(otpVerificationsTable).values({
    email: normalizedEmail,
    name: (name as string).trim(),
    passwordHash,
    mobileNumber: normalizedMobile,
    otp,
    expiresAt,
  });

  try {
    await sendOtpEmail(normalizedEmail, (name as string).trim(), otp);
  } catch (err) {
    req.log.error({ err }, "Failed to send OTP email");
    res
      .status(500)
      .json({ error: "Failed to send verification email. Please try again." });
    return;
  }

  res.json({ message: "OTP sent", pendingEmail: normalizedEmail });
});

// POST /api/auth/verify-otp — verifies OTP, creates user, returns token
router.post("/auth/verify-otp", async (req, res) => {
  const { email, otp } = req.body ?? {};
  if (!email || !otp) {
    res.status(400).json({ error: "email and otp are required" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();

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
  if (new Date() > pending.expiresAt) {
    await db
      .delete(otpVerificationsTable)
      .where(eq(otpVerificationsTable.email, normalizedEmail));
    res.status(410).json({ error: "Code expired. Please sign up again." });
    return;
  }
  if (pending.otp !== (otp as string).trim()) {
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
    .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, mobileNumber: usersTable.mobileNumber });

  await db
    .delete(otpVerificationsTable)
    .where(eq(otpVerificationsTable.email, normalizedEmail));

  const token = signToken(user.id);
  res.json({ token, user });
});

// POST /api/auth/resend-otp — regenerates and resends OTP
router.post("/auth/resend-otp", async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();

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

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

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
});

// POST /api/auth/forgot-password — sends OTP reset code to registered email
router.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();

  const [user] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "No account found with this email address" });
    return;
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

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
    res.status(500).json({ error: "Failed to send reset email. Please try again." });
    return;
  }

  res.json({ message: "Reset code sent", pendingEmail: normalizedEmail });
});

// POST /api/auth/resend-reset-otp — resends password reset OTP
router.post("/auth/resend-reset-otp", async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();

  const [pending] = await db
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res.status(404).json({ error: "No pending reset. Please request a new code." });
    return;
  }

  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

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
});

// POST /api/auth/reset-password — verifies OTP and updates password
router.post("/auth/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body ?? {};
  if (!email || !otp || !newPassword) {
    res.status(400).json({ error: "email, otp and newPassword are required" });
    return;
  }
  if ((newPassword as string).length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const normalizedEmail = (email as string).toLowerCase().trim();

  const [pending] = await db
    .select()
    .from(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail))
    .limit(1);

  if (!pending) {
    res.status(404).json({ error: "No pending reset. Please request a new code." });
    return;
  }
  if (new Date() > pending.expiresAt) {
    await db
      .delete(passwordResetsTable)
      .where(eq(passwordResetsTable.email, normalizedEmail));
    res.status(410).json({ error: "Code expired. Please request a new one." });
    return;
  }
  if (pending.otp !== (otp as string).trim()) {
    res.status(401).json({ error: "Incorrect code. Please try again." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.email, normalizedEmail));

  await db
    .delete(passwordResetsTable)
    .where(eq(passwordResetsTable.email, normalizedEmail));

  res.json({ message: "Password reset successfully" });
});

// POST /api/auth/login
router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, (email as string).toLowerCase()))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, mobileNumber: user.mobileNumber } });
});

// POST /api/auth/google — verifies the Google ID token on the server, then
// signs in an existing account or creates a new verified account.
router.post("/auth/google", async (req, res) => {
  const { idToken } = req.body ?? {};
  if (!idToken || typeof idToken !== "string") {
    res.status(400).json({ error: "Google ID token is required" });
    return;
  }

  const audiences = configuredGoogleClientIds();
  if (audiences.length === 0) {
    req.log.error("GOOGLE_CLIENT_IDS is not configured");
    res.status(503).json({ error: "Google sign-in is not configured yet" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      res.status(401).json({ error: "Your Google account email could not be verified" });
      return;
    }

    const email = payload.email.toLowerCase().trim();
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
        if (emailUser.googleSubject && emailUser.googleSubject !== payload.sub) {
          res.status(409).json({ error: "This email is already linked to another Google account" });
          return;
        }
        [user] = await db
          .update(usersTable)
          .set({ googleSubject: payload.sub })
          .where(eq(usersTable.id, emailUser.id))
          .returning();
      } else {
        const fallbackName = payload.name?.trim() || email.split("@")[0] || "Google User";
        const passwordHash = await bcrypt.hash(`google:${randomUUID()}`, 10);
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
      user: { id: user.id, email: user.email, name: user.name, mobileNumber: user.mobileNumber },
    });
  } catch (err) {
    req.log.warn({ err }, "Google ID token verification failed");
    res.status(401).json({ error: "Google sign-in could not be verified" });
  }
});

// GET /api/auth/me — returns all messes + all pending/rejected requests
router.get("/auth/me", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;

  // These datasets are independent. Fetch them in parallel and join the
  // membership/request names in SQL to avoid 4-6 sequential Neon round trips.
  const [userRows, adminMesses, memberships, requestRecords] = await Promise.all([
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
      .select({ id: messesTable.id, name: messesTable.name, messKey: messesTable.messKey })
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

  const messMap = new Map<number, {
    id: number;
    name: string;
    messKey: string;
    role: "admin" | "member";
  }>();
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
});

export default router;
