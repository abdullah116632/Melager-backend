import type { Request, Response } from "express";
import { HealthCheckResponse } from "../zod/index.js";

export const healthCheck = (_req: Request, res: Response) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};
