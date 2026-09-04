import { Router } from "express";

import {
  getUnreadConsumerBreakdownCount,
  markConsumerBreakdownNotificationsRead,
  sendConsumerBreakdownNotification,
} from "../controllers/consumerBreakdownNotificationController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/consumer-breakdown/unread-count", requireAuth, getUnreadConsumerBreakdownCount);
router.post("/mess/consumer-breakdown/notify", requireAuth, sendConsumerBreakdownNotification);
router.post("/mess/consumer-breakdown/read", requireAuth, markConsumerBreakdownNotificationsRead);

export default router;
