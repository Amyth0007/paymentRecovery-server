import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import {
  createEmployeeSchema,
  objectIdSchema,
  updateEmployeeSchema,
  userListQuerySchema,
} from "../../common/validators/schemas.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth,
  rejectMismatchedOrganization,
  requirePasswordChanged,
  requireRole,
  requireTenant,
} from "../../common/middleware/auth-guards.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { createEmployee, listEmployees, updateEmployee } from "./user.service.js";

export function createUserRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  router.use(
    requireAuth,
    requirePasswordChanged,
    requireTenant,
    requireRole("org_admin"),
    rejectMismatchedOrganization,
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = userListQuerySchema.parse(req.query);
      const result = await listEmployees(req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const body = createEmployeeSchema.parse(req.body);
      const user = await createEmployee(req.auth!, req.auth!.organizationId!, body, requestMeta(req));
      sendSuccess(res, user, undefined, 201);
    }),
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateEmployeeSchema.parse(req.body);
      sendSuccess(res, await updateEmployee(req.auth!, req.auth!.organizationId!, id, body, requestMeta(req)));
    }),
  );

  return router;
}
