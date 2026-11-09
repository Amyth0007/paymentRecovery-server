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
  cancelInvoiceSchema,
  createInvoiceDraftSchema,
  invoiceListQuerySchema,
  updateAcknowledgementSchema,
  updateInvoiceDraftSchema,
} from "./invoice.schemas.js";
import {
  cancelInvoice,
  createDraft,
  discardDraft,
  getAcknowledgementHistory,
  getInvoice,
  issueInvoice,
  listInvoices,
  updateAcknowledgement,
  updateDraft,
} from "./invoice.service.js";

export function createInvoiceRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("invoices"), rejectMismatchedOrganization);

  router.get(
    "/",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const query = invoiceListQuerySchema.parse(req.query);
      const result = await listInvoices(req.auth!.organizationId!, query);
      sendSuccess(res, result.items, result.meta);
    }),
  );

  router.post(
    "/",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const body = createInvoiceDraftSchema.parse(req.body);
      const invoice = await createDraft(
        req.auth!,
        req.auth!.organizationId!,
        body,
        requestMeta(req),
      );
      sendSuccess(res, invoice, undefined, 201);
    }),
  );

  router.get(
    "/:id",
    requireRole("org_admin", "accounts_manager", "employee"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getInvoice(req.auth!.organizationId!, id));
    }),
  );

  router.patch(
    "/:id",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateInvoiceDraftSchema.parse(req.body);
      sendSuccess(
        res,
        await updateDraft(req.auth!, req.auth!.organizationId!, id, body, requestMeta(req)),
      );
    }),
  );

  router.post(
    "/:id/issue",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(
        res,
        await issueInvoice(req.auth!, req.auth!.organizationId!, id, requestMeta(req)),
      );
    }),
  );

  router.post(
    "/:id/cancel",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = cancelInvoiceSchema.parse(req.body);
      sendSuccess(
        res,
        await cancelInvoice(req.auth!, req.auth!.organizationId!, id, body, requestMeta(req)),
      );
    }),
  );

  router.delete(
    "/:id",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(
        res,
        await discardDraft(req.auth!, req.auth!.organizationId!, id, requestMeta(req)),
      );
    }),
  );

  router.post(
    "/:id/acknowledgements",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      const body = updateAcknowledgementSchema.parse(req.body);
      sendSuccess(
        res,
        await updateAcknowledgement(
          req.auth!,
          req.auth!.organizationId!,
          id,
          body,
          requestMeta(req),
        ),
      );
    }),
  );

  router.get(
    "/:id/acknowledgements",
    requireRole("org_admin", "accounts_manager"),
    asyncHandler(async (req, res) => {
      const id = objectIdSchema.parse(req.params.id);
      sendSuccess(res, await getAcknowledgementHistory(req.auth!.organizationId!, id));
    }),
  );

  return router;
}
