import type { AuthContext, TenantRole } from "../../common/auth/auth-context.js";
import { hashPassword } from "../../common/auth/password.js";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import type { createEmployeeSchema, updateEmployeeSchema, userListQuerySchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { OrganizationModel } from "../organizations/organization.model.js";
import { isModuleEnabled, MODULES, type ModuleKey } from "../organizations/module-registry.js";
import { revokeAllRefreshTokens } from "../auth/refresh-token.service.js";
import { UserModel } from "./user.model.js";
import { ACTION_PERMISSIONS, type ActionPermissionKey } from "./permission-registry.js";
import { effectiveUserAccess } from "./user-access.service.js";
import { getAssignableCustomRole } from "./custom-role.service.js";
import { DepartmentModel } from "../workforce/department.model.js";
import { OfficeLocationModel } from "../attendance/office-location.model.js";

type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
type ListQuery = z.infer<typeof userListQuerySchema>;

const userSorts = {
  name: { name: 1 },
  "-name": { name: -1 },
  email: { email: 1 },
  "-email": { email: -1 },
  createdAt: { createdAt: 1 },
  "-createdAt": { createdAt: -1 },
} as const;

export function presentUser(user: {
  _id: { toString(): string };
  email: string;
  name: string;
  role: string;
  status: string;
  organizationId?: { toString(): string } | null;
  mustChangePassword: boolean;
  modulePermissions?: Map<string, boolean> | Record<string, boolean> | null;
  modulePermissionsConfigured?: boolean;
  actionPermissions?: string[];
  workforceScope?: { mode: "organization" | "selected"; departmentIds: Array<{ toString(): string }>; locationIds: Array<{ toString(): string }> } | null;
  customRoleId?: { toString(): string; _id?: unknown; name?: string; modulePermissions?: string[]; actionPermissions?: string[]; status?: string } | string | null;
}) {
  const populatedCustomRole = user.customRoleId && typeof user.customRoleId === "object" && "name" in user.customRoleId ? user.customRoleId : null;
  const roleModulePermissions = populatedCustomRole?.status === "active" ? populatedCustomRole.modulePermissions ?? [] : [];
  const roleActionPermissions = populatedCustomRole?.status === "active" ? populatedCustomRole.actionPermissions ?? [] : [];
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    organizationId: user.organizationId ? user.organizationId.toString() : null,
    mustChangePassword: user.mustChangePassword,
    modulePermissions: populatedCustomRole ? Object.fromEntries(roleModulePermissions.map((module) => [module, true])) : user.modulePermissions instanceof Map ? Object.fromEntries(user.modulePermissions) : user.modulePermissions ?? {},
    modulePermissionsConfigured: populatedCustomRole ? true : user.modulePermissionsConfigured ?? false,
    actionPermissions: populatedCustomRole ? roleActionPermissions : user.actionPermissions ?? [],
    customRoleId: user.customRoleId ? (populatedCustomRole && "_id" in populatedCustomRole ? String(populatedCustomRole._id) : user.customRoleId.toString()) : null,
    customRoleName: populatedCustomRole?.name ?? null,
    workforceScope: user.workforceScope ? { mode: user.workforceScope.mode, departmentIds: user.workforceScope.departmentIds.map((id) => id.toString()), locationIds: user.workforceScope.locationIds.map((id) => id.toString()) } : { mode: "organization", departmentIds: [], locationIds: [] },
  };
}

export async function presentSessionUser(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }
  const organization = user.organizationId
    ? await OrganizationModel.findById(user.organizationId)
    : null;
  const effectiveAccess = user.customRoleId ? await effectiveUserAccess(userId) : null;
  return {
    ...presentUser(user),
    ...(effectiveAccess ? { modulePermissions: Object.fromEntries(effectiveAccess.modules.map((module) => [module, true])), modulePermissionsConfigured: true, actionPermissions: effectiveAccess.actions, customRoleName: effectiveAccess.customRoleName } : {}),
    organization: organization
      ? {
          id: organization._id.toString(),
          name: organization.name,
          legalName: organization.legalName,
          address: organization.address,
          status: organization.status,
          timezone: organization.timezone,
          showGuides: organization.showGuides ?? true,
          currency: organization.currency,
          modules: Object.fromEntries(Object.keys(MODULES).map((key) => [key, isModuleEnabled(organization.modules, key as ModuleKey)])),
        }
      : null,
  };
}

export async function createEmployee(
  actor: AuthContext,
  organizationId: string,
  input: CreateEmployeeInput,
  meta: RequestMeta,
) {
  try {
    const organization = await OrganizationModel.findById(organizationId);
    const customRole = input.customRoleId ? await getAssignableCustomRole(organizationId, input.customRoleId) : null;
    const modulePermissions = customRole?.modulePermissions ?? input.modulePermissions ?? [];
    const actionPermissions = customRole?.actionPermissions ?? input.actionPermissions ?? [];
    if (input.role === "sub_admin" && modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Subadmins cannot be granted organization settings or team administration", 422);
    if (input.role !== "sub_admin" && input.actionPermissions?.length) throw new AppError("VALIDATION_ERROR", "Action permissions are only configurable for subadmins", 422);
    if (!customRole && input.actionPermissions?.some((key) => !modulePermissions.includes(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Action permissions require access to their parent module", 422);
    if (input.role !== "org_admin" && modulePermissions.some((key) => !isModuleEnabled(organization?.modules, key as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    if (input.workforceScope?.mode === "selected") {
      const [departments, locations] = await Promise.all([
        DepartmentModel.countDocuments({ organizationId, _id: { $in: input.workforceScope.departmentIds } }),
        OfficeLocationModel.countDocuments({ organizationId, _id: { $in: input.workforceScope.locationIds } }),
      ]);
      if (departments !== input.workforceScope.departmentIds.length || locations !== input.workforceScope.locationIds.length) throw new AppError("VALIDATION_ERROR", "Every scoped department and location must belong to this organization", 422);
    }
    const passwordHash = await hashPassword(input.temporaryPassword);
    const user = await UserModel.create({
      organizationId,
      email: input.email,
      name: input.name,
      passwordHash,
      role: input.role,
      modulePermissions: input.role !== "org_admin" ? new Map(modulePermissions.map((key) => [key, true])) : new Map(),
      modulePermissionsConfigured: input.role !== "org_admin" && (input.modulePermissions !== undefined || Boolean(customRole)),
      actionPermissions: input.role === "sub_admin" ? actionPermissions : [],
      customRoleId: customRole?._id ?? null,
      workforceScope: input.role === "sub_admin" ? input.workforceScope ?? { mode: "organization", departmentIds: [], locationIds: [] } : undefined,
      status: "active",
      mustChangePassword: false,
      tokenVersion: 0,
    });
    await recordAudit({
      actor,
      action: "user.created",
      entityType: "user",
      entityId: user._id.toString(),
      organizationId,
      after: { email: user.email, role: user.role, customRoleId: customRole?._id.toString() ?? null, customRoleName: customRole?.name ?? null, modulePermissions: Object.fromEntries(user.modulePermissions ?? new Map()), actionPermissions: user.actionPermissions ?? [] },
      meta,
    });
    return { ...presentUser(user), customRoleName: customRole?.name ?? null };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A user with this email already exists", 409);
    }
    throw error;
  }
}

export async function listEmployees(organizationId: string, query: ListQuery) {
  const filter: { organizationId: string; status?: "active" | "disabled" } = { organizationId };
  if (query.status) {
    filter.status = query.status;
  }
  const skip = (query.page - 1) * query.limit;
  const [users, total] = await Promise.all([
    UserModel.find(filter).populate("customRoleId", "name modulePermissions actionPermissions status").sort(userSorts[query.sort]).skip(skip).limit(query.limit),
    UserModel.countDocuments(filter),
  ]);
  return {
    items: users.map((user) => presentUser(user)),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function updateEmployee(
  actor: AuthContext,
  organizationId: string,
  userId: string,
  input: UpdateEmployeeInput,
  meta: RequestMeta,
) {
  const user = await UserModel.findOne({ _id: userId, organizationId });
  if (!user) {
    throw new AppError("NOT_FOUND", "Employee was not found", 404);
  }

  const nextRole = input.role ?? user.role;
  const nextStatus = input.status ?? user.status;
  if (user.role === "org_admin" && user.status === "active" && (nextRole !== "org_admin" || nextStatus !== "active")) {
    const otherAdmins = await UserModel.countDocuments({
      organizationId,
      role: "org_admin",
      status: "active",
      _id: { $ne: user._id },
    });
    if (otherAdmins === 0) {
      throw new AppError("INVALID_STATE", "The organization must keep one active administrator", 422);
    }
  }

  const before = { role: user.role, status: user.status, workforceScope: user.workforceScope, customRoleId: user.customRoleId?.toString() ?? null, modulePermissions: Object.fromEntries(user.modulePermissions ?? new Map()), modulePermissionsConfigured: user.modulePermissionsConfigured, actionPermissions: user.actionPermissions ?? [] };
  if (input.workforceScope !== undefined) {
    if (nextRole !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Data scopes can only be assigned to subadmins", 422);
    if (input.workforceScope.mode === "selected") {
      const [departments, locations] = await Promise.all([
        DepartmentModel.countDocuments({ organizationId, _id: { $in: input.workforceScope.departmentIds } }),
        OfficeLocationModel.countDocuments({ organizationId, _id: { $in: input.workforceScope.locationIds } }),
      ]);
      if (departments !== input.workforceScope.departmentIds.length || locations !== input.workforceScope.locationIds.length) throw new AppError("VALIDATION_ERROR", "Every scoped department and location must belong to this organization", 422);
    }
    user.workforceScope = input.workforceScope as never;
  }
  if (input.role) {
    user.role = input.role;
    if (input.role !== "sub_admin") user.workforceScope = undefined as never;
    else if (!user.workforceScope) user.workforceScope = { mode: "organization", departmentIds: [], locationIds: [] } as never;
  }
  if (input.status) {
    user.status = input.status;
  }
  if (input.role && input.role === "org_admin") {
    user.modulePermissions = new Map();
    user.modulePermissionsConfigured = false;
  }
  if (input.role === "sub_admin") {
    user.modulePermissions.delete("settings");
  }
  if (input.role && input.role !== "sub_admin") user.actionPermissions = [];
  if (input.role && input.role !== "sub_admin") user.customRoleId = null;
  let customRoleName: string | null = null;
  if (input.customRoleId !== undefined) {
    if (input.customRoleId === null) user.customRoleId = null;
    else {
      if (user.role !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Custom roles can only be assigned to subadmins", 422);
      const role = await getAssignableCustomRole(organizationId, input.customRoleId);
      user.customRoleId = role._id;
      user.modulePermissions = new Map(role.modulePermissions.map((key) => [key, true]));
      user.modulePermissionsConfigured = true;
      user.actionPermissions = role.actionPermissions as ActionPermissionKey[];
      customRoleName = role.name;
    }
  }
  if (input.modulePermissions !== undefined || input.actionPermissions !== undefined) user.customRoleId = null;
  if (input.modulePermissions !== undefined) {
    const organization = await OrganizationModel.findById(organizationId);
    if (user.role === "org_admin") throw new AppError("VALIDATION_ERROR", "Organization administrators have full module access", 422);
    if (user.role === "sub_admin" && input.modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Subadmins cannot be granted organization settings or team administration", 422);
    if (input.modulePermissions.some((key) => !isModuleEnabled(organization?.modules, key))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    user.modulePermissions = new Map(input.modulePermissions.map((key) => [key, true]));
    user.modulePermissionsConfigured = true;
    const grantedModules = new Set<string>(input.modulePermissions);
    user.actionPermissions = (user.actionPermissions ?? []).filter((key) => grantedModules.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module ?? ""));
  }
  if (input.actionPermissions !== undefined) {
    if (user.role !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Action permissions are only configurable for subadmins", 422);
    const grantedModules = new Set<string>(input.modulePermissions ?? [...(user.modulePermissions ?? new Map()).keys()]);
    if (input.actionPermissions.some((key) => !grantedModules.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)!.module))) throw new AppError("VALIDATION_ERROR", "Action permissions require access to their parent module", 422);
    user.actionPermissions = input.actionPermissions as ActionPermissionKey[];
  }
  if (input.temporaryPassword) {
    user.passwordHash = await hashPassword(input.temporaryPassword);
    user.mustChangePassword = false;
    user.tokenVersion += 1;
    await revokeAllRefreshTokens(user._id.toString());
  }
  if (input.status === "disabled") {
    user.tokenVersion += 1;
    await revokeAllRefreshTokens(user._id.toString());
  }
  const accessRole = user.customRoleId ? await getAssignableCustomRole(organizationId, user.customRoleId.toString()).catch(() => null) : null;
  await user.save();
  try {
    await recordAudit({
      actor,
      action: "user.updated",
      entityType: "user",
      entityId: user._id.toString(),
      organizationId,
      before,
      after: { role: user.role, status: user.status, customRoleId: user.customRoleId?.toString() ?? null, customRoleName: customRoleName ?? accessRole?.name ?? null, modulePermissions: Object.fromEntries(user.modulePermissions ?? new Map()), modulePermissionsConfigured: user.modulePermissionsConfigured, actionPermissions: user.actionPermissions ?? [], passwordReset: Boolean(input.temporaryPassword) },
      meta,
    });
  } catch (error) {
    // The user update is already committed. An audit store outage must not report
    // the role change as failed after it has taken effect.
    console.error("Could not record user update audit event", {
      userId: user._id.toString(),
      organizationId,
      error,
    });
  }
  return { ...presentUser(user), customRoleName: customRoleName ?? accessRole?.name ?? null };
}

export function isTenantRole(role: string): role is TenantRole {
  return role !== "super_admin";
}
