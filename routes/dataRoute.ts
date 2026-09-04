import { Router } from "express";

import {
  getMonthData,
  getDailyMealChanges,
  sendBlendedSummary,
  sendSummary,
  setDeposit,
  setExpense,
  setMeal,
} from "../controllers/dataController.js";
import { syncDailyMeal } from "../controllers/dailyMealsSyncController.js";
import { syncExpenseDay } from "../controllers/expenseSyncController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/data/:yearMonth", requireAuth, getMonthData);
router.put("/mess/meals", requireAuth, setMeal);
router.post("/mess/daily-meals/sync", requireAuth, syncDailyMeal);
router.get("/mess/daily-meals/changes", requireAuth, getDailyMealChanges);
router.put("/mess/expenses", requireAuth, setExpense);
router.post("/mess/expenses/sync", requireAuth, syncExpenseDay);
router.put("/mess/deposits", requireAuth, setDeposit);
router.post("/mess/send-summary", requireAuth, sendSummary);
router.post("/mess/send-blended-summary", requireAuth, sendBlendedSummary);

export default router;
