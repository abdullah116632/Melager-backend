import type { Request, Response } from "express";

import {
  LATEST_APP_VERSION,
  MIN_APP_VERSION,
  PLAY_STORE_URL,
} from "../lib/appVersion.js";

// GET /api/app/version — public; the app compares its own version against this
export const getAppVersionPolicy = (_req: Request, res: Response) => {
  res.json({
    minVersion: MIN_APP_VERSION,
    latestVersion: LATEST_APP_VERSION,
    storeUrl: PLAY_STORE_URL,
  });
};
