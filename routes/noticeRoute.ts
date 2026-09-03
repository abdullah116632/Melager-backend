import { Router } from "express";
import {
  createNotice,
  deleteNotice,
  getNotices,
  getNotifications,
  markNotificationRead,
  reorderNotices,
  updateNotice,
} from "../controllers/noticeController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/notices", requireAuth, getNotices);
router.post("/mess/notices", requireAuth, createNotice);
router.patch("/mess/notices/reorder", requireAuth, reorderNotices);
router.patch("/mess/notices/:id", requireAuth, updateNotice);
router.delete("/mess/notices/:id", requireAuth, deleteNotice);
router.get("/mess/notifications", requireAuth, getNotifications);
router.post("/mess/notifications/:id/read", requireAuth, markNotificationRead);

export default router;
