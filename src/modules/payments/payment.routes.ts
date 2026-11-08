import { Router } from "express";
import { randomUUID } from "node:crypto";
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
  createPaymentSchema,
  paymentListQuerySchema,
  reversePaymentSchema,
} from "./payment.schemas.js";
import {
  createPayment,
  getInvoiceLedger,
  getPayment,
  listPayments,
  reversePayment,
} from "./payment.service.js";

export function createPaymentRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const query = paymentListQuerySchema.parse(req.query);
      const result = await listPayments(req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const body = createPaymentSchema.parse(req.body);
      const idempotencyKey =
        req.header("Idempotency-Key") || req.header("idempotency-key") || randomUUID();

      const payment = await createPayment(
        req.auth!,
        req.auth!.organizationId!,
        body,
        idempotencyKey,
        requestMeta(req),
      );
      sendSuccess(res, payment, undefined, 201);
    }),
  );

  router.get(
    "/invoices/:invoiceId/ledger",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const invoiceId = objectIdSchema.parse(req.params.invoiceId);
      sendSuccess(res, await getInvoiceLedger(req.auth!.organizationId!, invoiceId));
    }),
  );

  router.get(
    "/:id",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getPayment(req.auth!.organizationId!, id));
    }),
  );

  router.post(
    "/:id/reverse",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = reversePaymentSchema.parse(req.body);
      const idempotencyKey =
        req.header("Idempotency-Key") || req.header("idempotency-key") || randomUUID();

      const reversal = await reversePayment(
        req.auth!,
        req.auth!.organizationId!,
        id,
        body,
        idempotencyKey,
        requestMeta(req),
      );
      sendSuccess(res, reversal);
    }),
  );

  return router;
}
