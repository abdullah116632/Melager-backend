import { Router } from "express";

import { createMessage, getMessages } from "../controllers/messageController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/messages", requireAuth, getMessages);
router.post("/mess/messages", requireAuth, createMessage);

export default router;
