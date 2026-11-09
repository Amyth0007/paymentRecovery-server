import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { updateOwnOrganizationSchema } from "../../common/validators/schemas.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import {
  createRequireAuth,
  rejectMismatchedOrganization,
  requirePasswordChanged,
  requireRole,
  requireTenant,
} from "../../common/middleware/auth-guards.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { getOwnOrganization, updateOwnOrganization } from "./organization.service.js";

export function createOrganizationRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("settings"), rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getOwnOrganization(req.auth!.organizationId!));
    }),
  );

  router.patch(
    "/",
    requireRole("org_admin"),
    asyncHandler(async (req, res) => {
      const body = updateOwnOrganizationSchema.parse(req.body);
      sendSuccess(
        res,
        await updateOwnOrganization(req.auth!, req.auth!.organizationId!, body, requestMeta(req)),
      );
    }),
  );

  return router;
}
