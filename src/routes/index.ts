import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import messRouter from "./mess.js";
import dataRouter from "./data.js";
import settingsRouter from "./settings.js";
import mealScheduleRouter from "./meal-schedule.js";
import depositEntriesRouter from "./deposit-entries.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(messRouter);
router.use(dataRouter);
router.use(settingsRouter);
router.use(mealScheduleRouter);
router.use(depositEntriesRouter);

export default router;
