import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { auditListQuerySchema } from "../../common/validators/schemas.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth,
  requirePasswordChanged,
  requireRole,
  requireTenant,
} from "../../common/middleware/auth-guards.js";
import { listAudits } from "./audit.service.js";

export function createAuditRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  router.use(requireAuth, requirePasswordChanged, requireTenant, requireRole("org_admin"));

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = auditListQuerySchema.parse(req.query);
      const result = await listAudits({
        ...query,
        organizationId: req.auth!.organizationId,
      });
      sendSuccess(res, result.items, result.meta);
    }),
  );

  return router;
}
