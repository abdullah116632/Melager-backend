import { Router } from "express";

import {
  acceptMemberRequest,
  addConsumer,
  createMess,
  deleteConsumer,
  getConsumers,
  getMemberRequests,
  getMessInfo,
  inviteToMess,
  joinMess,
  rejoinMess,
  rejectMemberRequest,
} from "../controllers/messController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/mess/create", requireAuth, createMess);
router.post("/mess/join", requireAuth, joinMess);
router.get("/mess/member-requests", requireAuth, getMemberRequests);
router.post(
  "/mess/member-requests/:id/accept",
  requireAuth,
  acceptMemberRequest,
);
router.post(
  "/mess/member-requests/:id/reject",
  requireAuth,
  rejectMemberRequest,
);
router.get("/mess/info", requireAuth, getMessInfo);
router.get("/mess/consumers", requireAuth, getConsumers);
router.post("/mess/consumers", requireAuth, addConsumer);
router.delete("/mess/consumers/:id", requireAuth, deleteConsumer);
router.post("/mess/invite", requireAuth, inviteToMess);
router.post("/mess/rejoin", requireAuth, rejoinMess);

export default router;
