import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { asyncHandler } from "./async-handler.js";
import { eq } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { organizations } from "../../database/schema.js";
import { isUuid } from "../utils/db.js";
import { organizationModules } from "../../modules/organizations/organization.service.js";
import { effectiveUserAccess } from "../../modules/users/user-access.service.js";
import { usesActionPermissions, type AuthContext } from "../auth/auth-context.js";
import { isModuleEnabled, type ModuleKey } from "../../modules/organizations/module-registry.js";

export async function assertModuleEnabled(organizationId: string, moduleKey: ModuleKey): Promise<void> {
  const [organization] = isUuid(organizationId)
    ? await db.select({ modules: organizations.modules }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
    : [];
  if (!organization || !isModuleEnabled(organizationModules(organization.modules), moduleKey)) {
    throw new AppError("MODULE_DISABLED", "This module is not enabled for your organization", 403);
  }
}

export async function assertModuleAccess(organizationId: string, moduleKey: ModuleKey, actor?: AuthContext): Promise<void> {
  await assertModuleEnabled(organizationId, moduleKey);
  // Guards only have attendance station routes; those routes have their own role checks.
  // Allow the attendance module gate so the employee picker and punch station work for guard accounts.
  if (actor?.role === "guard" && moduleKey === "attendance") return;
  if (actor && actor.role !== "org_admin" && actor.role !== "super_admin") {
    const access = await effectiveUserAccess(actor.userId);
    if (!access?.modules.includes(moduleKey)) {
      throw new AppError("MODULE_DISABLED", "Your administrator has not granted access to this screen", 403);
    }
    if (usesActionPermissions(actor) && !access.actions.some((permission) => permission.startsWith(`${moduleKey}.`))) {
      throw new AppError("FORBIDDEN", "Your administrator has not granted access to this module's actions", 403);
    }
  }
}

export function requireEnabledModule(moduleKey: ModuleKey): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const organizationId = req.auth?.organizationId;
    if (!organizationId) throw new AppError("FORBIDDEN", "Organization access is required", 403);
    await assertModuleAccess(organizationId, moduleKey, req.auth);
    next();
  });
}
