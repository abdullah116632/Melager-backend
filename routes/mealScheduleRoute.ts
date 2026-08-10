import { Router } from "express";

import {
  getMealOptOuts,
  getTodaySchedule,
  setMealSchedule,
  toggleMealOptOut,
} from "../controllers/mealScheduleController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/today-schedule", requireAuth, getTodaySchedule);
router.put("/mess/meal-schedule", requireAuth, setMealSchedule);
router.post("/mess/meal-opt-out", requireAuth, toggleMealOptOut);
router.get("/mess/meal-opt-outs", requireAuth, getMealOptOuts);

export default router;
