import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { eq } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { organizations } from "../../database/schema.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { assignCompensation, createCompensationComponent, createDailyEarning, createPayStructure, listCompensation, listDailyEarnings, reviewDailyEarning, listPayrollRuns, createPayrollRun, createPayrollRevision, cancelPayrollRevision, submitPayrollRun, approvePayrollRun, finalizePayrollRun, recordPayrollPayment, updatePayStructure, deletePayStructure, updateCompensationAssignment, deleteCompensationAssignment, cancelPayrollRun, deletePayrollRun } from "./workforce.service.js";
import { compensationAssignmentSchema, componentSchema, dailyEarningCreateSchema, dailyEarningReviewSchema, payStructureSchema, payrollPaymentSchema, payrollPeriodSchema, payrollRevisionSchema, workforceListSchema } from "./workforce.schemas.js";
import { listPayrollEmployees } from "./workforce.service.js";

export function createPayrollRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("payroll"), rejectMismatchedOrganization, requireRole("org_admin", "sub_admin"));
  router.get("/compensation", requireActionPermission("payroll.view_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await listCompensation(req.auth!, req.auth!.organizationId!))));
  router.get("/employees", requireActionPermission("payroll.view_compensation"), asyncHandler(async (req, res) => { const result = await listPayrollEmployees(req.auth!, req.auth!.organizationId!, workforceListSchema.parse(req.query)); sendSuccess(res, result.items, result.meta); }));
  router.post("/components", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await createCompensationComponent(req.auth!, req.auth!.organizationId!, componentSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.post("/structures", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await createPayStructure(req.auth!, req.auth!.organizationId!, payStructureSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/structures/:id", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await updatePayStructure(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), payStructureSchema.parse(req.body), requestMeta(req)))));
  router.delete("/structures/:id", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await deletePayStructure(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/assignments", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await assignCompensation(req.auth!, req.auth!.organizationId!, compensationAssignmentSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/assignments/:id", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await updateCompensationAssignment(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), compensationAssignmentSchema.parse(req.body), requestMeta(req)))));
  router.delete("/assignments/:id", requireActionPermission("payroll.manage_compensation"), asyncHandler(async (req, res) => sendSuccess(res, await deleteCompensationAssignment(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.get("/daily-earnings", requireActionPermission("payroll.view_earnings"), asyncHandler(async (req, res) => sendSuccess(res, await listDailyEarnings(req.auth!, req.auth!.organizationId!, typeof req.query.from === "string" ? req.query.from : undefined, typeof req.query.to === "string" ? req.query.to : undefined, typeof req.query.employeeId === "string" ? objectIdSchema.parse(req.query.employeeId) : undefined))));
  router.post("/daily-earnings", requireActionPermission("payroll.manage_earnings"), asyncHandler(async (req, res) => {
    const [organization] = await db.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, req.auth!.organizationId!)).limit(1);
    sendSuccess(res, await createDailyEarning(req.auth!, req.auth!.organizationId!, organization?.currency ?? "INR", dailyEarningCreateSchema.parse(req.body), requestMeta(req)), undefined, 201);
  }));
  router.patch("/daily-earnings/:id/review", requireActionPermission("payroll.approve_earnings"), asyncHandler(async (req, res) => sendSuccess(res, await reviewDailyEarning(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), dailyEarningReviewSchema.parse(req.body), requestMeta(req)))));
  router.get("/runs", requireActionPermission("payroll.view_earnings"), asyncHandler(async (req, res) => sendSuccess(res, await listPayrollRuns(req.auth!, req.auth!.organizationId!))));
  router.post("/runs", requireActionPermission("payroll.create_run"), asyncHandler(async (req, res) => {
    const [organization] = await db.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, req.auth!.organizationId!)).limit(1);
    sendSuccess(res, await createPayrollRun(req.auth!, req.auth!.organizationId!, organization?.currency ?? "INR", payrollPeriodSchema.parse(req.body), requestMeta(req)), undefined, 201);
  }));
  router.post("/runs/:id/cancel", requireActionPermission("payroll.create_run"), asyncHandler(async (req, res) => sendSuccess(res, await cancelPayrollRun(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.delete("/runs/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("payroll.create_run"), asyncHandler(async (req, res) => sendSuccess(res, await deletePayrollRun(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/runs/:id/revisions", requireActionPermission("payroll.create_run"), asyncHandler(async (req, res) => sendSuccess(res, await createPayrollRevision(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), payrollRevisionSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.post("/runs/:id/cancel-revision", requireActionPermission("payroll.create_run"), asyncHandler(async (req, res) => sendSuccess(res, await cancelPayrollRevision(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/runs/:id/submit", requireActionPermission("payroll.submit_run"), asyncHandler(async (req, res) => sendSuccess(res, await submitPayrollRun(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/runs/:id/approve", requireActionPermission("payroll.approve_run"), asyncHandler(async (req, res) => sendSuccess(res, await approvePayrollRun(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/runs/:id/finalize", requireActionPermission("payroll.finalize_run"), asyncHandler(async (req, res) => sendSuccess(res, await finalizePayrollRun(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/runs/:id/payments", requireActionPermission("payroll.record_payment"), asyncHandler(async (req, res) => sendSuccess(res, await recordPayrollPayment(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), payrollPaymentSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  return router;
}
