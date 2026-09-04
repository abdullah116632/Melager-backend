import { Router } from "express";
import {
  createNotice,
  deleteNotice,
  getNotices,
  getUnreadNoticesCount,
  getNotifications,
  markNoticesRead,
  markNotificationRead,
  reorderNotices,
  updateNotice,
} from "../controllers/noticeController.js";
import { registerPushToken } from "../controllers/pushTokenController.js";
import { requireAuth } from "../middleware/auth.js";
import { syncNoticeMutation } from "../controllers/noticeSyncController.js";

const router = Router();

router.get("/mess/notices", requireAuth, getNotices);
router.post("/mess/notices/sync", requireAuth, syncNoticeMutation);
router.get("/mess/notices/unread-count", requireAuth, getUnreadNoticesCount);
router.post("/mess/notices", requireAuth, createNotice);
router.post("/mess/notices/read", requireAuth, markNoticesRead);
router.patch("/mess/notices/reorder", requireAuth, reorderNotices);
router.patch("/mess/notices/:id", requireAuth, updateNotice);
router.delete("/mess/notices/:id", requireAuth, deleteNotice);
router.get("/mess/notifications", requireAuth, getNotifications);
router.post("/mess/notifications/:id/read", requireAuth, markNotificationRead);
router.post("/devices/push-token", requireAuth, registerPushToken);

export default router;
