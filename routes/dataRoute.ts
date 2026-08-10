import { Router } from "express";

import {
  getMonthData,
  sendBlendedSummary,
  sendSummary,
  setDeposit,
  setExpense,
  setMeal,
} from "../controllers/dataController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/data/:yearMonth", requireAuth, getMonthData);
router.put("/mess/meals", requireAuth, setMeal);
router.put("/mess/expenses", requireAuth, setExpense);
router.put("/mess/deposits", requireAuth, setDeposit);
router.post("/mess/send-summary", requireAuth, sendSummary);
router.post("/mess/send-blended-summary", requireAuth, sendBlendedSummary);

export default router;
