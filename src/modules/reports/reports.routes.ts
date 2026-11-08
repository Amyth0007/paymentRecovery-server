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
import {
  getAgingBuckets,
  getCustomerOutstandingReport,
  getDashboardMetrics,
} from "./reports.service.js";

export function createReportsRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, rejectMismatchedOrganization);

  router.get(
    "/dashboard",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getDashboardMetrics(req.auth!.organizationId!));
    }),
  );

  router.get(
    "/aging",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getAgingBuckets(req.auth!.organizationId!));
    }),
  );

  router.get(
    "/outstanding/customers",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getCustomerOutstandingReport(req.auth!.organizationId!));
    }),
  );

  return router;
}
