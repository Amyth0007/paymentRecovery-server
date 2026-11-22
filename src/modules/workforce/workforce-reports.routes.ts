import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { z } from "zod";
import { attendanceReport, leaveReport, overtimeReport, payrollReport } from "./workforce-reports.service.js";

const querySchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).refine((value) => value.to >= value.from, { message: "End date must be on or after start date", path: ["to"] });

export function createWorkforceReportsRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, rejectMismatchedOrganization, requireEnabledModule("reports"));
  router.get("/attendance", requireEnabledModule("attendance"), requireActionPermission("attendance.view_all"), asyncHandler(async (req, res) => { const query = querySchema.parse(req.query); sendSuccess(res, await attendanceReport(req.auth!, req.auth!.organizationId!, query.from, query.to)); }));
  router.get("/payroll", requireEnabledModule("payroll"), requireActionPermission("payroll.view_earnings"), asyncHandler(async (req, res) => { const query = querySchema.parse(req.query); sendSuccess(res, await payrollReport(req.auth!, req.auth!.organizationId!, query.from, query.to)); }));
  router.get("/overtime", requireEnabledModule("overtime"), requireActionPermission("overtime.view"), asyncHandler(async (req, res) => { const query = querySchema.parse(req.query); sendSuccess(res, await overtimeReport(req.auth!, req.auth!.organizationId!, query.from, query.to)); }));
  router.get("/leave", requireEnabledModule("leave"), requireActionPermission("leave.view"), asyncHandler(async (req, res) => { const query = querySchema.parse(req.query); sendSuccess(res, await leaveReport(req.auth!, req.auth!.organizationId!, query.from, query.to)); }));
  return router;
}
