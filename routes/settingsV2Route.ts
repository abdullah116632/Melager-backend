import { Router } from "express";

import {
  addCoAdminV2,
  getEligibleAdminsV2,
  getMessAdminsV2,
  removeSelfAdminV2,
  requestEmailChangeV2,
  resendEmailChangeOtpV2,
  transferAdminV2,
  verifyIdentityV2,
} from "../controllers/settingsV2Controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/v2/settings/security/admins", requireAuth, getMessAdminsV2);
router.get(
  "/v2/settings/security/eligible-admins",
  requireAuth,
  getEligibleAdminsV2,
);
router.post("/v2/settings/security/add-co-admin", requireAuth, addCoAdminV2);
router.post("/v2/settings/security/add-admin", requireAuth, transferAdminV2);
router.post(
  "/v2/settings/security/remove-self-admin",
  requireAuth,
  removeSelfAdminV2,
);

router.post(
  "/v2/settings/security/verify-identity",
  requireAuth,
  verifyIdentityV2,
);
router.post(
  "/v2/settings/security/request-email-change",
  requireAuth,
  requestEmailChangeV2,
);
router.post(
  "/v2/settings/security/resend-email-change",
  requireAuth,
  resendEmailChangeOtpV2,
);

export default router;
