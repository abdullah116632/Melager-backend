import { Router } from "express";

import { getAppVersionPolicy } from "../controllers/appVersionController.js";

const router = Router();

router.get("/app/version", getAppVersionPolicy);

export default router;
