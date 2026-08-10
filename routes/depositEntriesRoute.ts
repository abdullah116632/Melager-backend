import { Router } from "express";

import {
  addDepositEntry,
  deleteDepositEntry,
  getDepositEntries,
} from "../controllers/depositEntriesController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/mess/deposit-entry", requireAuth, addDepositEntry);
router.get("/mess/deposit-entries", requireAuth, getDepositEntries);
router.delete("/mess/deposit-entry/:id", requireAuth, deleteDepositEntry);

export default router;
