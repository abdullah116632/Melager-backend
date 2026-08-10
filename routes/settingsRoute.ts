import { Router } from "express";

import {
  addCoAdmin,
  changePassword,
  getEligibleAdmins,
  requestSecurityOtp,
  transferAdmin,
  updateEmail,
  updateMess,
  updatePhone,
  updateProfile,
} from "../controllers/settingsController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/settings/security/request-otp", requireAuth, requestSecurityOtp);
router.post("/settings/security/change-password", requireAuth, changePassword);
router.post("/settings/security/update-email", requireAuth, updateEmail);
router.post("/settings/security/add-admin", requireAuth, transferAdmin);
router.post("/settings/security/add-co-admin", requireAuth, addCoAdmin);
router.get(
  "/settings/security/eligible-admins",
  requireAuth,
  getEligibleAdmins,
);
router.patch("/settings/profile", requireAuth, updateProfile);
router.patch("/settings/profile/phone", requireAuth, updatePhone);
router.patch("/settings/mess", requireAuth, updateMess);

export default router;
