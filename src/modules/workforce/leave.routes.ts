import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { createLeaveType, deleteLeaveType, updateLeaveType, listLeaveRequests, listLeaveTypes, listOwnLeaveRequests, requestLeave, reviewLeave } from "./leave.service.js";
import { leaveRequestSchema, leaveReviewSchema, leaveTypeSchema } from "./workforce.schemas.js";

export function createLeaveRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("leave"), rejectMismatchedOrganization);
  router.get("/types", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.view"), asyncHandler(async (req, res) => sendSuccess(res, await listLeaveTypes(req.auth!.organizationId!))));
  router.get("/types/available", requireRole("employee"), asyncHandler(async (req, res) => sendSuccess(res, await listLeaveTypes(req.auth!.organizationId!, false))));
  router.post("/types", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.manage_types"), asyncHandler(async (req, res) => sendSuccess(res, await createLeaveType(req.auth!, req.auth!.organizationId!, leaveTypeSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/types/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.manage_types"), asyncHandler(async (req, res) => sendSuccess(res, await updateLeaveType(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), leaveTypeSchema.parse(req.body), requestMeta(req)))));
  router.delete("/types/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.manage_types"), asyncHandler(async (req, res) => sendSuccess(res, await deleteLeaveType(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/requests", requireRole("org_admin", "sub_admin", "employee"), requireActionPermission("leave.request"), asyncHandler(async (req, res) => sendSuccess(res, await requestLeave(req.auth!, req.auth!.organizationId!, leaveRequestSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.get("/requests/mine", requireRole("employee"), requireActionPermission("leave.view"), asyncHandler(async (req, res) => {
    const requests = await listOwnLeaveRequests(req.auth!, req.auth!.organizationId!);
    sendSuccess(res, requests);
  }));
  router.get("/requests", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.view"), asyncHandler(async (req, res) => sendSuccess(res, await listLeaveRequests(req.auth!.organizationId!, undefined, req.auth!))));
  router.patch("/requests/:id/review", requireRole("org_admin", "sub_admin"), requireActionPermission("leave.approve"), asyncHandler(async (req, res) => sendSuccess(res, await reviewLeave(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), leaveReviewSchema.parse(req.body), requestMeta(req)))));
  return router;
}
