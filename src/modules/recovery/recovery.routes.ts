import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth,
  rejectMismatchedOrganization,
  requirePasswordChanged,
  requireRole,
  requireTenant,
} from "../../common/middleware/auth-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import {
  assignmentListQuerySchema,
  createAssignmentSchema,
  createVisitSchema,
  updateAssignmentStatusSchema,
} from "./recovery.schemas.js";
import {
  createAssignment,
  createCallAttempt,
  createVisit,
  getAssignment,
  listAssignments,
  listVisits,
  updateAssignmentStatus,
} from "./recovery.service.js";

export function createRecoveryRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager", "field_recovery"),
    asyncHandler(async (req, res) => {
      const query = assignmentListQuerySchema.parse(req.query);
      const result = await listAssignments(req.auth!, req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const body = createAssignmentSchema.parse(req.body);
      const assignment = await createAssignment(
        req.auth!,
        req.auth!.organizationId!,
        body,
        requestMeta(req),
      );
      sendSuccess(res, assignment, undefined, 201);
    }),
  );

  router.get(
    "/:id",
    requireRole("org_admin", "accounts_manager", "field_recovery"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getAssignment(req.auth!, req.auth!.organizationId!, id));
    }),
  );

  router.patch(
    "/:id",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateAssignmentStatusSchema.parse(req.body);
      sendSuccess(
        res,
        await updateAssignmentStatus(
          req.auth!,
          req.auth!.organizationId!,
          id,
          body,
          requestMeta(req),
        ),
      );
    }),
  );

  router.post(
    "/:id/invoices/:invoiceId/call-attempts",
    requireRole("org_admin", "accounts_manager", "field_recovery"),
    asyncHandler(async (req, res) => {
      const assignmentId = objectIdSchema.parse(req.params.id);
      const invoiceId = objectIdSchema.parse(req.params.invoiceId);
      sendSuccess(res, await createCallAttempt(req.auth!, req.auth!.organizationId!, assignmentId, invoiceId, requestMeta(req)), undefined, 201);
    }),
  );

  router.post(
    "/:id/visits",
    requireRole("org_admin", "accounts_manager", "field_recovery"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = createVisitSchema.parse(req.body);
      const visit = await createVisit(
        req.auth!,
        req.auth!.organizationId!,
        id,
        body,
        requestMeta(req),
      );
      sendSuccess(res, visit, undefined, 201);
    }),
  );

  router.get(
    "/:id/visits",
    requireRole("org_admin", "accounts_manager", "field_recovery"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await listVisits(req.auth!, req.auth!.organizationId!, id));
    }),
  );

  return router;
}
