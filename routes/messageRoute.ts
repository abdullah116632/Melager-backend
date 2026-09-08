import { Router } from "express";

import {
  createMessage,
  getMessages,
  getUnreadMessageCount,
  markMessagesRead,
} from "../controllers/messageController.js";
import { setMessageReaction } from "../controllers/messageReactionController.js";
import { syncMessage } from "../controllers/messageSyncController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/messages", requireAuth, getMessages);
router.get("/mess/messages/unread-count", requireAuth, getUnreadMessageCount);
router.post("/mess/messages", requireAuth, createMessage);
router.post("/mess/messages/sync", requireAuth, syncMessage);
router.post("/mess/messages/read", requireAuth, markMessagesRead);
router.post("/mess/messages/reaction", requireAuth, setMessageReaction);

export default router;
