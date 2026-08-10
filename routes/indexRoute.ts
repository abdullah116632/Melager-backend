import { Router, type IRouter } from "express";
import healthRouter from "./healthRoute.js";
import authRouter from "./authRoute.js";
import messRouter from "./messRoute.js";
import dataRouter from "./dataRoute.js";
import settingsRouter from "./settingsRoute.js";
import mealScheduleRouter from "./mealScheduleRoute.js";
import depositEntriesRouter from "./depositEntriesRoute.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(messRouter);
router.use(dataRouter);
router.use(settingsRouter);
router.use(mealScheduleRouter);
router.use(depositEntriesRouter);

export default router;
