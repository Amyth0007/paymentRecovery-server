import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, requirePasswordChanged, requireRole } from "../../common/middleware/auth-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { listPendingComplianceRules, reviewComplianceRule } from "./compliance.service.js";
import { complianceReviewSchema } from "./workforce.schemas.js";

export function createCompliancePlatformRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireRole("super_admin"));
  router.get("/pending", asyncHandler(async (_req, res) => sendSuccess(res, await listPendingComplianceRules())));
  router.post("/:organizationId/rules/:id/review", asyncHandler(async (req, res) => sendSuccess(res, await reviewComplianceRule(req.auth!, objectIdSchema.parse(req.params.organizationId), objectIdSchema.parse(req.params.id), complianceReviewSchema.parse(req.body), requestMeta(req)))));
  return router;
}
