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
  cancelCommitmentSchema,
  commitmentListQuerySchema,
  createCommitmentSchema,
  evaluateCommitmentSchema,
} from "./commitment.schemas.js";
import {
  cancelCommitment,
  createCommitment,
  evaluateCommitment,
  getCommitment,
  listCommitments,
} from "./commitment.service.js";

export function createCommitmentRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("commitments"), rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const query = commitmentListQuerySchema.parse(req.query);
      const result = await listCommitments(req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    requireRole("org_admin", "accounts_manager", "field_recovery", "employee"),
    asyncHandler(async (req, res) => {
      const body = createCommitmentSchema.parse(req.body);
      const commitment = await createCommitment(
        req.auth!,
        req.auth!.organizationId!,
        body,
        requestMeta(req),
      );
      sendSuccess(res, commitment, undefined, 201);
    }),
  );

  router.get(
    "/:id",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getCommitment(req.auth!.organizationId!, id));
    }),
  );

  router.post(
    "/:id/cancel",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = cancelCommitmentSchema.parse(req.body);
      sendSuccess(
        res,
        await cancelCommitment(req.auth!, req.auth!.organizationId!, id, body, requestMeta(req)),
      );
    }),
  );

  router.post(
    "/:id/evaluate",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = evaluateCommitmentSchema.parse(req.body);
      sendSuccess(
        res,
        await evaluateCommitment(
          req.auth!,
          req.auth!.organizationId!,
          id,
          body,
          requestMeta(req),
        ),
      );
    }),
  );

  return router;
}
