import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { activateComplianceRule, createComplianceRule, listComplianceRules, submitComplianceRule } from "./compliance.service.js";
import { complianceRuleSchema } from "./workforce.schemas.js";

export function createComplianceRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("compliance"), rejectMismatchedOrganization, requireRole("org_admin", "sub_admin"));
  router.get("/rules", requireActionPermission("compliance.view"), asyncHandler(async (req, res) => sendSuccess(res, await listComplianceRules(req.auth!.organizationId!))));
  router.post("/rules", requireActionPermission("compliance.manage"), asyncHandler(async (req, res) => sendSuccess(res, await createComplianceRule(req.auth!, req.auth!.organizationId!, complianceRuleSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.post("/rules/:id/submit", requireActionPermission("compliance.manage"), asyncHandler(async (req, res) => sendSuccess(res, await submitComplianceRule(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/rules/:id/activate", requireRole("org_admin"), asyncHandler(async (req, res) => sendSuccess(res, await activateComplianceRule(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  return router;
}
