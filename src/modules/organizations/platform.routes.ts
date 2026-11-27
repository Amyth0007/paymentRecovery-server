import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { sendError } from "../../common/utils/api-response.js";
import { passwordSchema } from "../../common/validators/schemas.js";
import { getOrganizationInsights, getPlatformInsights, impersonateOrganization, resetOrganizationAdminPassword } from "./platform.service.js";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import {
  createOrganizationSchema,
  createPlanSchema,
  objectIdSchema,
  organizationListQuerySchema,
  updateStatusSchema,
  moduleKeySchema,
  updateModuleSchema,
  upsertSubscriptionSchema,
} from "../../common/validators/schemas.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth,
  rejectMismatchedOrganization,
  requirePasswordChanged,
  requireRole,
} from "../../common/middleware/auth-guards.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { listAudits } from "../audit-logs/audit.service.js";
import { auditListQuerySchema } from "../../common/validators/schemas.js";
import {
  createOrganization,
  createPlan,
  listOrganizations,
  listPlans,
  presentOrganization,
  updateOrganizationStatus,
  updateOrganizationModule,
  upsertSubscription,
} from "./organization.service.js";

export function createPlatformRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  router.use(requireAuth, requirePasswordChanged, requireRole("super_admin"), rejectMismatchedOrganization);

  router.post(
    "/organizations",
    asyncHandler(async (req, res) => {
      const body = createOrganizationSchema.parse(req.body);
      const organization = await createOrganization(req.auth!, body, requestMeta(req));
      sendSuccess(res, organization, undefined, 201);
    }),
  );

  router.get(
    "/organizations",
    asyncHandler(async (req, res) => {
      const query = organizationListQuerySchema.parse(req.query);
      const result = await listOrganizations(query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.get(
    "/organizations/:id",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await presentOrganization(id));
    }),
  );

  router.patch(
    "/organizations/:id/modules/:moduleId",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const moduleId = moduleKeySchema.parse(req.params.moduleId);
      const body = updateModuleSchema.parse(req.body);
      sendSuccess(res, await updateOrganizationModule(req.auth!, id, moduleId, body.enabled, requestMeta(req)));
    }),
  );

  router.patch(
    "/organizations/:id/status",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateStatusSchema.parse(req.body);
      sendSuccess(res, await updateOrganizationStatus(req.auth!, id, body, requestMeta(req)));
    }),
  );

  router.post(
    "/plans",
    asyncHandler(async (req, res) => {
      const body = createPlanSchema.parse(req.body);
      sendSuccess(res, await createPlan(req.auth!, body, requestMeta(req)), undefined, 201);
    }),
  );

  router.get(
    "/plans",
    asyncHandler(async (_req, res) => {
      sendSuccess(res, await listPlans());
    }),
  );

  router.patch(
    "/organizations/:id/subscription",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = upsertSubscriptionSchema.parse(req.body);
      sendSuccess(res, await upsertSubscription(req.auth!, id, body, requestMeta(req)));
    }),
  );

  const limitImpersonation = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, { statusCode: 429, code: "RATE_LIMITED", message: "Too many attempts. Try again later." }),
  });

  router.get(
    "/insights",
    asyncHandler(async (_req, res) => {
      sendSuccess(res, await getPlatformInsights());
    }),
  );

  router.get(
    "/organizations/:id/insights",
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getOrganizationInsights(objectIdSchema.parse(req.params.id)));
    }),
  );

  router.post(
    "/organizations/:id/impersonate",
    limitImpersonation,
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = z.object({ masterPassword: z.string().min(1).max(256) }).parse(req.body);
      sendSuccess(res, await impersonateOrganization(req.auth!, id, body.masterPassword, config, requestMeta(req)));
    }),
  );

  router.post(
    "/organizations/:id/admins/:userId/password",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const userId = objectIdSchema.parse(req.params.userId);
      const body = z.object({ temporaryPassword: passwordSchema }).parse(req.body);
      sendSuccess(res, await resetOrganizationAdminPassword(req.auth!, id, userId, body.temporaryPassword, requestMeta(req)));
    }),
  );

  router.get(
    "/audit-logs",
    asyncHandler(async (req, res) => {
      const query = auditListQuerySchema.parse(req.query);
      const result = await listAudits({ ...query, actorRole: "super_admin" });
      sendSuccess(res, result.items, result.meta);
    }),
  );

  return router;
}
