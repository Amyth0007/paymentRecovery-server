import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth, rejectMismatchedOrganization, requirePasswordChanged,
  requireRole, requireTenant,
} from "../../common/middleware/auth-guards.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import {
  attendanceDashboard, checkIn, checkOut, createCorrectionRequest, createOfficeLocation,
  getAttendanceConfig, listAttendanceRecords, listCorrections, listEmployeeCorrections,
  reviewCorrection, updateAttendancePolicy, updateOfficeLocation,
} from "./attendance.service.js";
import {
  attendanceListQuerySchema, attendancePolicySchema, attendancePunchSchema,
  correctionCreateSchema, correctionListQuerySchema, correctionReviewSchema,
  officeLocationSchema,
} from "./attendance.schemas.js";

export function createAttendanceRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("attendance"), rejectMismatchedOrganization);

  router.get("/config", asyncHandler(async (req, res) => {
    sendSuccess(res, await getAttendanceConfig(req.auth!.organizationId!));
  }));

  router.patch("/policy", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const input = attendancePolicySchema.parse(req.body);
    sendSuccess(res, await updateAttendancePolicy(req.auth!, req.auth!.organizationId!, input, requestMeta(req)));
  }));

  router.post("/locations", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const input = officeLocationSchema.parse(req.body);
    sendSuccess(res, await createOfficeLocation(req.auth!, req.auth!.organizationId!, input, requestMeta(req)), undefined, 201);
  }));

  router.patch("/locations/:id", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const id = objectIdSchema.parse(req.params.id);
    const input = officeLocationSchema.parse(req.body);
    sendSuccess(res, await updateOfficeLocation(req.auth!, req.auth!.organizationId!, id, input, requestMeta(req)));
  }));

  router.get("/dashboard", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    sendSuccess(res, await attendanceDashboard(req.auth!.organizationId!, date));
  }));

  router.get("/records", asyncHandler(async (req, res) => {
    const query = attendanceListQuerySchema.parse(req.query);
    const result = await listAttendanceRecords(req.auth!, req.auth!.organizationId!, query);
    sendSuccess(res, result.items, result.meta);
  }));

  router.post("/check-in", asyncHandler(async (req, res) => {
    const input = attendancePunchSchema.extend({ officeLocationId: objectIdSchema }).parse(req.body);
    sendSuccess(res, await checkIn(req.auth!, req.auth!.organizationId!, input, requestMeta(req)), undefined, 201);
  }));

  router.post("/check-out", asyncHandler(async (req, res) => {
    const input = attendancePunchSchema.parse(req.body);
    sendSuccess(res, await checkOut(req.auth!, req.auth!.organizationId!, input, requestMeta(req)));
  }));

  router.post("/corrections", asyncHandler(async (req, res) => {
    const input = correctionCreateSchema.parse(req.body);
    sendSuccess(res, await createCorrectionRequest(req.auth!, req.auth!.organizationId!, input, requestMeta(req)), undefined, 201);
  }));

  router.get("/corrections/mine", asyncHandler(async (req, res) => {
    const query = correctionListQuerySchema.parse(req.query);
    const result = await listEmployeeCorrections(req.auth!, req.auth!.organizationId!, query);
    sendSuccess(res, result.items, result.meta);
  }));

  router.get("/corrections", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const query = correctionListQuerySchema.parse(req.query);
    const result = await listCorrections(req.auth!.organizationId!, query);
    sendSuccess(res, result.items, result.meta);
  }));

  router.patch("/corrections/:id/review", requireRole("org_admin"), asyncHandler(async (req, res) => {
    const id = objectIdSchema.parse(req.params.id);
    const input = correctionReviewSchema.parse(req.body);
    sendSuccess(res, await reviewCorrection(req.auth!, req.auth!.organizationId!, id, input, requestMeta(req)));
  }));

  return router;
}
