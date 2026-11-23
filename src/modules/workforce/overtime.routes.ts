import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { createOvertimeEntry, createOvertimePolicy, deleteOvertimePolicy, listOvertime, reviewOvertime, updateOvertimePolicy } from "./workforce.service.js";
import { dailyEarningReviewSchema, overtimeCreateSchema, overtimePolicySchema } from "./workforce.schemas.js";

export function createOvertimeRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("overtime"), rejectMismatchedOrganization, requireRole("org_admin", "sub_admin"));
  router.get("/", requireActionPermission("overtime.view"), asyncHandler(async (req, res) => {
    const section = req.query.section === "policies" || req.query.section === "entries" ? req.query.section : "all";
    sendSuccess(res, await listOvertime(req.auth!, req.auth!.organizationId!, section));
  }));
  router.post("/policies", requireActionPermission("overtime.manage_policy"), asyncHandler(async (req, res) => sendSuccess(res, await createOvertimePolicy(req.auth!, req.auth!.organizationId!, overtimePolicySchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/policies/:id", requireActionPermission("overtime.manage_policy"), asyncHandler(async (req, res) => sendSuccess(res, await updateOvertimePolicy(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), overtimePolicySchema.parse(req.body), requestMeta(req)))));
  router.delete("/policies/:id", requireActionPermission("overtime.manage_policy"), asyncHandler(async (req, res) => sendSuccess(res, await deleteOvertimePolicy(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/entries", requireActionPermission("overtime.create"), asyncHandler(async (req, res) => sendSuccess(res, await createOvertimeEntry(req.auth!, req.auth!.organizationId!, overtimeCreateSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/entries/:id/review", requireActionPermission("overtime.approve"), asyncHandler(async (req, res) => sendSuccess(res, await reviewOvertime(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), dailyEarningReviewSchema.parse(req.body), requestMeta(req)))));
  return router;
}
