import type { CookieOptions, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { Router } from "express";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { sendError, sendSuccess } from "../../common/utils/api-response.js";
import { loginSchema } from "../../common/validators/schemas.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { createRequireAuth } from "../../common/middleware/auth-guards.js";
import { getMe, login, logout, refresh } from "./auth.service.js";

export const REFRESH_COOKIE = "refresh_token";

function cookieOptions(config: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/api/v1/auth",
    maxAge: config.refreshTtlDays * 24 * 60 * 60 * 1000,
  };
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === "string" ? value : undefined;
}

function setRefreshCookie(res: Response, token: string, config: AuthConfig) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(config));
}

export function createAuthRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const limitLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(res, {
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "Too many login attempts. Try again later.",
      });
    },
  });

  router.post(
    "/login",
    limitLogin,
    asyncHandler(async (req, res) => {
      const body = loginSchema.parse(req.body);
      const session = await login(body, config);
      setRefreshCookie(res, session.refreshToken, config);
      sendSuccess(res, { accessToken: session.accessToken, user: session.user });
    }),
  );

  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const session = await refresh(readRefreshCookie(req), config);
      setRefreshCookie(res, session.refreshToken, config);
      sendSuccess(res, { accessToken: session.accessToken, user: session.user });
    }),
  );

  router.post(
    "/logout",
    requireAuth,
    asyncHandler(async (req, res) => {
      await logout(req.auth!, readRefreshCookie(req));
      res.clearCookie(REFRESH_COOKIE, cookieOptions(config));
      sendSuccess(res, { loggedOut: true });
    }),
  );

  router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      sendSuccess(res, await getMe(req.auth!));
    }),
  );

  return router;
}
