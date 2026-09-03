import { Router } from "express";

import {
  getMealOptOuts,
  getMealStatusCalendarV2,
  getMealStatusDayV2,
  getTodaySchedule,
  setMealSchedule,
  toggleMealOptOut,
  toggleMealOptOutV2,
} from "../controllers/mealScheduleController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/today-schedule", requireAuth, getTodaySchedule);
router.put("/mess/meal-schedule", requireAuth, setMealSchedule);
router.post("/mess/meal-opt-out", requireAuth, toggleMealOptOut);
router.get("/mess/meal-opt-outs", requireAuth, getMealOptOuts);
router.get("/v2/mess/meal-status/day", requireAuth, getMealStatusDayV2);
router.get(
  "/v2/mess/meal-status/calendar",
  requireAuth,
  getMealStatusCalendarV2,
);
router.post("/v2/mess/meal-status/opt-out", requireAuth, toggleMealOptOutV2);

export default router;
