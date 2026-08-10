import { Router } from "express";

import {
  forgotPassword,
  googleLogin,
  login,
  me,
  resendOtp,
  resendResetOtp,
  resetPassword,
  signup,
  verifyOtp,
} from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/auth/signup", signup);
router.post("/auth/verify-otp", verifyOtp);
router.post("/auth/resend-otp", resendOtp);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/resend-reset-otp", resendResetOtp);
router.post("/auth/reset-password", resetPassword);
router.post("/auth/login", login);
router.post("/auth/google", googleLogin);
router.get("/auth/me", requireAuth, me);

export default router;
