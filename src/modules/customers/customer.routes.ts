import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
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
  createCustomerSchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from "./customer.schemas.js";
import {
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "./customer.service.js";

export function createCustomerRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("customers"), rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const query = customerListQuerySchema.parse(req.query);
      const result = await listCustomers(req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const body = createCustomerSchema.parse(req.body);
      const customer = await createCustomer(
        req.auth!,
        req.auth!.organizationId!,
        body,
        requestMeta(req),
      );
      sendSuccess(res, customer, undefined, 201);
    }),
  );

  router.get(
    "/:id",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getCustomer(req.auth!.organizationId!, id));
    }),
  );

  router.patch(
    "/:id",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateCustomerSchema.parse(req.body);
      sendSuccess(
        res,
        await updateCustomer(req.auth!, req.auth!.organizationId!, id, body, requestMeta(req)),
      );
    }),
  );

  router.post(
    "/:id/archive",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(
        res,
        await archiveCustomer(req.auth!, req.auth!.organizationId!, id, requestMeta(req)),
      );
    }),
  );

  return router;
}
