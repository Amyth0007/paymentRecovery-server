import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import type { customRoleInputSchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { isModuleEnabled, type ModuleKey } from "../organizations/module-registry.js";
import { OrganizationModel } from "../organizations/organization.model.js";
import { ACTION_PERMISSIONS } from "./permission-registry.js";
import { CustomRoleModel } from "./custom-role.model.js";
import { UserModel } from "./user.model.js";

type RoleInput = z.infer<typeof customRoleInputSchema>;
function roleView(role: any) { return { id: role._id.toString(), name: role.name, description: role.description, modulePermissions: role.modulePermissions, actionPermissions: role.actionPermissions, status: role.status, createdAt: role.createdAt, updatedAt: role.updatedAt }; }

async function validateRole(organizationId: string, input: RoleInput) {
  if (input.modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Custom subadmin roles cannot manage organization settings or team access", 422);
  const organization = await OrganizationModel.findById(organizationId).select("modules");
  if (input.modulePermissions.some((module) => !isModuleEnabled(organization?.modules, module))) throw new AppError("VALIDATION_ERROR", "Custom roles can only use modules enabled for this organization", 422);
  const moduleSet = new Set(input.modulePermissions);
  if (input.actionPermissions.some((key) => !moduleSet.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Every action must belong to an enabled module selected for this role", 422);
  for (const module of input.modulePermissions) if (!input.actionPermissions.some((key) => ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module === module)) throw new AppError("VALIDATION_ERROR", `Choose at least one action for the ${module} module`, 422);
}

export async function listCustomRoles(organizationId: string) {
  return (await CustomRoleModel.find({ organizationId, status: "active" }).sort({ name: 1 }).lean()).map(roleView);
}

export async function getAssignableCustomRole(organizationId: string, roleId: string) {
  const role = await CustomRoleModel.findOne({ _id: roleId, organizationId, status: "active" }).lean();
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found in this organization", 404);
  return role;
}

export async function saveCustomRole(actor: AuthContext, organizationId: string, input: RoleInput, id: string | undefined, meta: RequestMeta) {
  await validateRole(organizationId, input);
  const previous = id ? await CustomRoleModel.findOne({ _id: id, organizationId, status: "active" }).lean() : null;
  let role;
  try {
    role = id
      ? await CustomRoleModel.findOneAndUpdate({ _id: id, organizationId, status: "active" }, { $set: { ...input, updatedBy: actor.userId } }, { new: true, runValidators: true })
      : await CustomRoleModel.create({ ...input, organizationId, createdBy: actor.userId, updatedBy: actor.userId });
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("CONFLICT", "A custom role with this name already exists", 409);
    throw error;
  }
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found", 404);
  await recordAudit({ actor, action: id ? "user.custom_role_updated" : "user.custom_role_created", entityType: "custom_role", entityId: role._id.toString(), organizationId, ...(previous ? { before: roleView(previous) } : {}), after: roleView(role), meta });
  return roleView(role);
}

export async function archiveCustomRole(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  if (await UserModel.exists({ organizationId, customRoleId: id })) throw new AppError("CONFLICT", "Reassign all subadmins using this role before archiving it", 409);
  const role = await CustomRoleModel.findOneAndUpdate({ _id: id, organizationId, status: "active" }, { $set: { status: "archived", updatedBy: actor.userId } }, { new: true });
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found", 404);
  await recordAudit({ actor, action: "user.custom_role_archived", entityType: "custom_role", entityId: id, organizationId, after: { status: role.status, name: role.name }, meta });
  return { id, status: role.status };
}
