import { Router } from "express";
import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/utils/api-response.js";

export function createHealthRouter(isDatabaseConnected: () => boolean): Router {
  const router = Router();

  router.get("/", (_req, res, next) => {
    try {
      if (!isDatabaseConnected()) {
        throw new AppError("SERVICE_UNAVAILABLE", "Database is not reachable", 503, {
          database: "disconnected",
        });
      }
      sendSuccess(res, { status: "ok", database: "connected" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
