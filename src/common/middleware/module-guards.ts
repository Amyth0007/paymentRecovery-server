import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { asyncHandler } from "./async-handler.js";
import { OrganizationModel } from "../../modules/organizations/organization.model.js";
import { UserModel } from "../../modules/users/user.model.js";
import type { AuthContext } from "../auth/auth-context.js";
import { isModuleEnabled, type ModuleKey } from "../../modules/organizations/module-registry.js";

export async function assertModuleEnabled(organizationId: string, moduleKey: ModuleKey): Promise<void> {
  const organization = await OrganizationModel.findById(organizationId).select("modules");
  if (!organization || !isModuleEnabled(organization.modules, moduleKey)) {
    throw new AppError("MODULE_DISABLED", "This module is not enabled for your organization", 403);
  }
}

export async function assertModuleAccess(organizationId: string, moduleKey: ModuleKey, actor?: AuthContext): Promise<void> {
  await assertModuleEnabled(organizationId, moduleKey);
  if (actor && actor.role !== "org_admin" && actor.role !== "super_admin") {
    const user = await UserModel.findById(actor.userId).select("modulePermissions modulePermissionsConfigured");
    if (user?.modulePermissionsConfigured && !user.modulePermissions?.get(moduleKey)) throw new AppError("MODULE_DISABLED", "Your administrator has not granted access to this screen", 403);
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
