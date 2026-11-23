import { Router } from "express";
import multer from "multer";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth, rejectMismatchedOrganization, requireActionPermission, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import {
  createWorkforceEmployee, listWorkforceEmployees, listWorkforceLoginAccounts, updateWorkforceEmployee,
  listDepartments, saveDepartment, listDesignations, saveDesignation,
  listShifts, createShift, updateShift, deleteShift, assignShift,
  requestShiftSwap, listShiftSwaps, reviewShiftSwap, cancelShiftSwap,
} from "./workforce.service.js";
import {
  departmentSchema, designationSchema, employeeCreateSchema, employeeUpdateSchema,
  workforceListSchema, shiftSchema, shiftAssignmentSchema,
  shiftSwapCreateSchema, shiftSwapReviewSchema,
} from "./workforce.schemas.js";
import { importEmployeesFromWorkbook } from "./employee-import.service.js";

const uploadWorkbook = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => {
  if (!/\.xlsx$/i.test(file.originalname)) return callback(new AppError("VALIDATION_ERROR", "Upload an .xlsx workbook", 422));
  callback(null, true);
} });

export function createWorkforceRouter(config: AuthConfig) {
  const router = Router();
  router.use(createRequireAuth(config), requirePasswordChanged, requireTenant, requireEnabledModule("workforce"), rejectMismatchedOrganization);
  router.get("/employees", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.view"), asyncHandler(async (req, res) => { const result = await listWorkforceEmployees(req.auth!, req.auth!.organizationId!, workforceListSchema.parse(req.query)); sendSuccess(res, result.items, result.meta); }));
  router.get("/login-accounts", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_employees"), asyncHandler(async (req, res) => sendSuccess(res, await listWorkforceLoginAccounts(req.auth!, req.auth!.organizationId!))));
  router.post("/employees", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_employees"), asyncHandler(async (req, res) => sendSuccess(res, await createWorkforceEmployee(req.auth!, req.auth!.organizationId!, employeeCreateSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/employees/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_employees"), asyncHandler(async (req, res) => sendSuccess(res, await updateWorkforceEmployee(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), employeeUpdateSchema.parse(req.body), requestMeta(req)))));
  router.post("/employees/import", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_employees"), (req, res, next) => uploadWorkbook.single("file")(req, res, (error) => {
    if (error && "code" in error && error.code === "LIMIT_FILE_SIZE") return next(new AppError("VALIDATION_ERROR", "Workbook must be 4 MB or smaller", 413));
    next(error);
  }), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError("VALIDATION_ERROR", "Choose an .xlsx workbook to import", 422);
    sendSuccess(res, await importEmployeesFromWorkbook(req.auth!, req.auth!.organizationId!, req.file.buffer, requestMeta(req)), undefined, 201);
  }));
  router.get("/departments", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.view"), asyncHandler(async (req, res) => sendSuccess(res, await listDepartments(req.auth!.organizationId!))));
  router.post("/departments", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_departments"), asyncHandler(async (req, res) => sendSuccess(res, await saveDepartment(req.auth!, req.auth!.organizationId!, departmentSchema.parse(req.body), undefined, requestMeta(req)), undefined, 201)));
  router.patch("/departments/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_departments"), asyncHandler(async (req, res) => sendSuccess(res, await saveDepartment(req.auth!, req.auth!.organizationId!, departmentSchema.parse(req.body), objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.get("/designations", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.view"), asyncHandler(async (req, res) => sendSuccess(res, await listDesignations(req.auth!.organizationId!))));
  router.post("/designations", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_departments"), asyncHandler(async (req, res) => sendSuccess(res, await saveDesignation(req.auth!, req.auth!.organizationId!, designationSchema.parse(req.body), undefined, requestMeta(req)), undefined, 201)));
  router.patch("/designations/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_departments"), asyncHandler(async (req, res) => sendSuccess(res, await saveDesignation(req.auth!, req.auth!.organizationId!, designationSchema.parse(req.body), objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.get("/shifts", requireRole("org_admin", "sub_admin", "employee"), requireActionPermission("workforce.view_shifts"), asyncHandler(async (req, res) => {
    const value = req.query.section;
    const section = value === "shifts" || value === "assignments" || value === "assignment-form" ? value : "all";
    sendSuccess(res, await listShifts(req.auth!, req.auth!.organizationId!, section));
  }));
  router.post("/shifts", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await createShift(req.auth!, req.auth!.organizationId!, shiftSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.patch("/shifts/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await updateShift(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), shiftSchema.parse(req.body), requestMeta(req)))));
  router.delete("/shifts/:id", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await deleteShift(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));
  router.post("/shift-assignments", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await assignShift(req.auth!, req.auth!.organizationId!, shiftAssignmentSchema.parse(req.body), requestMeta(req)), undefined, 201)));

  // Shift swaps
  router.post("/shift-swaps", requireRole("org_admin", "sub_admin", "employee"), asyncHandler(async (req, res) => sendSuccess(res, await requestShiftSwap(req.auth!, req.auth!.organizationId!, shiftSwapCreateSchema.parse(req.body), requestMeta(req)), undefined, 201)));
  router.get("/shift-swaps/mine", requireRole("org_admin", "sub_admin", "employee"), asyncHandler(async (req, res) => sendSuccess(res, await listShiftSwaps(req.auth!, req.auth!.organizationId!, true))));
  router.get("/shift-swaps", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.view_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await listShiftSwaps(req.auth!, req.auth!.organizationId!, false))));
  router.patch("/shift-swaps/:id/review", requireRole("org_admin", "sub_admin"), requireActionPermission("workforce.manage_shifts"), asyncHandler(async (req, res) => sendSuccess(res, await reviewShiftSwap(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), shiftSwapReviewSchema.parse(req.body), requestMeta(req)))));
  router.delete("/shift-swaps/:id", requireRole("org_admin", "sub_admin", "employee"), asyncHandler(async (req, res) => sendSuccess(res, await cancelShiftSwap(req.auth!, req.auth!.organizationId!, objectIdSchema.parse(req.params.id), requestMeta(req)))));

  return router;
}
