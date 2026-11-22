import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { listOwnPayrollRuns } from "./workforce.service.js";

export function createSelfPayrollRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("payroll"), rejectMismatchedOrganization, requireRole("employee"));
  router.get("/", asyncHandler(async (req, res) => sendSuccess(res, await listOwnPayrollRuns(req.auth!, req.auth!.organizationId!))));
  return router;
}
