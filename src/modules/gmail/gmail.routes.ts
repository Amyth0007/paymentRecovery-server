import { Router } from "express";
import { z } from "zod";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { requireEnabledModule } from "../../common/middleware/module-guards.js";
import { createRequireAuth, requirePasswordChanged, requireRole, requireTenant } from "../../common/middleware/auth-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { beginGmailAuthorization, completeGmailAuthorization, disconnectGmail, gmailConnectionStatus, sendGmail } from "./gmail.service.js";

const sendEmailSchema = z.object({
  customerId: z.string().regex(/^[a-f\d]{24}$/i),
  invoiceId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  recipientEmail: z.email().max(254),
  subject: z.string().trim().min(1).max(998),
  body: z.string().trim().min(1).max(100_000),
});

export function createGmailRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.get("/oauth/callback", asyncHandler(async (req, res) => {
    const origin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
    if (typeof req.query.error === "string") {
      res.redirect(`${origin}/settings?gmail=error&reason=${encodeURIComponent(req.query.error)}`);
      return;
    }
    if (typeof req.query.code !== "string" || typeof req.query.state !== "string") {
      throw new AppError("INVALID_OAUTH_CALLBACK", "Google authorization response is incomplete", 400);
    }
    const clientOrigin = await completeGmailAuthorization(req.query.code, req.query.state);
    res.redirect(`${clientOrigin}/settings?gmail=connected`);
  }));

  router.use(requireAuth, requirePasswordChanged, requireTenant, requireEnabledModule("gmail"));

  router.get("/connection", requireRole("org_admin", "accounts_manager"), asyncHandler(async (req, res) => {
    sendSuccess(res, await gmailConnectionStatus(req.auth!.organizationId!));
  }));

  router.post("/oauth/start", requireRole("org_admin"), asyncHandler(async (req, res) => {
    sendSuccess(res, { authorizationUrl: await beginGmailAuthorization(req.auth!) });
  }));

  router.post("/disconnect", requireRole("org_admin"), asyncHandler(async (req, res) => {
    await disconnectGmail(req.auth!.organizationId!);
    sendSuccess(res, { disconnected: true });
  }));

  router.post("/send", requireRole("org_admin", "accounts_manager"), asyncHandler(async (req, res) => {
    const input = sendEmailSchema.parse(req.body);
    sendSuccess(res, await sendGmail(req.auth!, input), undefined, 201);
  }));

  return router;
}
