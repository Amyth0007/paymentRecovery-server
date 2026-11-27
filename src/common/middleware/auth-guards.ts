import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import type { AuthConfig, Role } from "../auth/auth-context.js";
import type { ActionPermissionKey } from "../../modules/users/permission-registry.js";
import { readAccessToken } from "../auth/tokens.js";
import { asyncHandler } from "./async-handler.js";
import { eq } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { users } from "../../database/schema.js";
import { isUuid } from "../utils/db.js";
import { effectiveUserAccess } from "../../modules/users/user-access.service.js";
import { assertTenantAccessible } from "../../modules/organizations/organization.service.js";
import { recordAudit, requestMeta } from "../../modules/audit-logs/audit.service.js";

export function createRequireAuth(config: AuthConfig): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
    }

    let claims;
    try {
      claims = readAccessToken(header.slice("Bearer ".length).trim(), config);
    } catch {
      throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
    }

    const [user] = isUuid(claims.sub) ? await db.select().from(users).where(eq(users.id, claims.sub)).limit(1) : [];
    if (!user || user.status !== "active" || user.tokenVersion !== claims.tokenVersion) {
      throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
    }

    req.auth = {
      userId: user.id,
      role: user.role as Role,
      organizationId: user.organizationId ?? null,
      tokenVersion: user.tokenVersion,
      mustChangePassword: user.mustChangePassword,
      workforceScope: user.role === "sub_admin" && user.workforceScope ? { mode: user.workforceScope.mode, departmentIds: [...user.workforceScope.departmentIds], locationIds: [...user.workforceScope.locationIds] } : undefined,
    };
    next();
  });
}

export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (req.auth?.mustChangePassword) {
    next(
      new AppError(
        "PASSWORD_CHANGE_REQUIRED",
        "Change the temporary password before continuing",
        403,
      ),
    );
    return;
  }
  next();
};

export const requireTenant: RequestHandler = asyncHandler(async (req, _res, next) => {
  const organizationId = req.auth?.organizationId;
  if (!req.auth || !organizationId) {
    throw new AppError("FORBIDDEN", "Organization access is required", 403);
  }
  await assertTenantAccessible(organizationId);
  next();
});

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      next(new AppError("FORBIDDEN", "You do not have access to this action", 403));
      return;
    }
    next();
  };
}

export function requireActionPermission(permission: ActionPermissionKey): RequestHandler {
  return requireAnyActionPermission(permission);
}

export function requireAnyActionPermission(...permissions: ActionPermissionKey[]): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (!req.auth) throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
    if (req.auth.role === "org_admin" || req.auth.role === "super_admin") {
      next();
      return;
    }
    if (req.auth.role !== "sub_admin" && req.auth.role !== "guard") {
      next();
      return;
    }
    const access = await effectiveUserAccess(req.auth.userId);
    const hasPermission = access?.actions.some((grant) => permissions.includes(grant as ActionPermissionKey)) ?? false;
    const grantsModuleView = permissions.some((permission) => permission.endsWith(".view") && Boolean(access?.actions.some((grant) => grant.startsWith(`${permission.slice(0, -5)}.`) && grant !== permission)));
    if (!hasPermission && !grantsModuleView) {
      throw new AppError("FORBIDDEN", "Your administrator has not granted permission for this action", 403);
    }
    next();
  });
}

export const rejectMismatchedOrganization: RequestHandler = asyncHandler(async (req, _res, next) => {
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || !("organizationId" in body)) {
    next();
    return;
  }
  const supplied = body.organizationId;
  if (supplied == null) {
    next();
    return;
  }
  const actual = req.auth?.organizationId ?? null;
  if (typeof supplied === "string" && supplied === actual) {
    next();
    return;
  }
  if (req.auth) {
    await recordAudit({
      actor: req.auth,
      action: "cross_tenant_rejected",
      entityType: "organization",
      entityId: typeof supplied === "string" ? supplied : "invalid",
      organizationId: actual,
      meta: requestMeta(req),
    });
  }
  throw new AppError("FORBIDDEN", "Organization id does not match the signed-in user", 403);
});
