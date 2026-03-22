import { Router } from "express";
import type { hotRestartService } from "../services/hot-restart.js";

export function systemRoutes(
  hotRestart: ReturnType<typeof hotRestartService>,
) {
  const router = Router();

  router.get("/system/hot-restart", (_req, res) => {
    res.json(hotRestart.getState());
  });

  router.post("/system/hot-restart", async (req, res) => {
    const companyId =
      (req.query.companyId as string) ||
      "aa1782c8-2c99-4563-bc18-733e5f0290b9";
    const state = await hotRestart.requestRestart(companyId);
    res.json(state);
  });

  return router;
}
