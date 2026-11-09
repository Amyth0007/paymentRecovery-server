import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { asyncHandler } from "./async-handler.js";
import { OrganizationModel } from "../../modules/organizations/organization.model.js";
import type { ModuleKey } from "../../modules/organizations/module-registry.js";

export async function assertModuleEnabled(organizationId: string, moduleKey: ModuleKey): Promise<void> {
  const organization = await OrganizationModel.findById(organizationId).select("modules");
  if (!organization || organization.modules?.get(moduleKey) !== true) {
    throw new AppError("MODULE_DISABLED", "This module is not enabled for your organization", 403);
  }
}

export function requireEnabledModule(moduleKey: ModuleKey): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const organizationId = req.auth?.organizationId;
    if (!organizationId) throw new AppError("FORBIDDEN", "Organization access is required", 403);
    await assertModuleEnabled(organizationId, moduleKey);
    next();
  });
}
