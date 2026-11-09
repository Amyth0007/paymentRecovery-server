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
}) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    organizationId: user.organizationId ? user.organizationId.toString() : null,
    mustChangePassword: user.mustChangePassword,
    modulePermissions: user.modulePermissions instanceof Map ? Object.fromEntries(user.modulePermissions) : user.modulePermissions ?? {},
    modulePermissionsConfigured: user.modulePermissionsConfigured ?? false,
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
  return {
    ...presentUser(user),
    organization: organization
      ? {
          id: organization._id.toString(),
          name: organization.name,
          status: organization.status,
          timezone: organization.timezone,
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
    if (input.role !== "org_admin" && input.modulePermissions?.some((key) => !isModuleEnabled(organization?.modules, key))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    const passwordHash = await hashPassword(input.temporaryPassword);
    const user = await UserModel.create({
      organizationId,
      email: input.email,
      name: input.name,
      passwordHash,
      role: input.role,
      modulePermissions: input.role !== "org_admin" ? new Map((input.modulePermissions ?? []).map((key) => [key, true])) : new Map(),
      modulePermissionsConfigured: input.role !== "org_admin" && input.modulePermissions !== undefined,
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
      after: { email: user.email, role: user.role },
      meta,
    });
    return presentUser(user);
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
    UserModel.find(filter).sort(userSorts[query.sort]).skip(skip).limit(query.limit),
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

  const before = { role: user.role, status: user.status, modulePermissions: Object.fromEntries(user.modulePermissions ?? new Map()), modulePermissionsConfigured: user.modulePermissionsConfigured };
  if (input.role) {
    user.role = input.role;
  }
  if (input.status) {
    user.status = input.status;
  }
  if (input.role && input.role === "org_admin") {
    user.modulePermissions = new Map();
    user.modulePermissionsConfigured = false;
  }
  if (input.modulePermissions !== undefined) {
    const organization = await OrganizationModel.findById(organizationId);
    if (user.role === "org_admin") throw new AppError("VALIDATION_ERROR", "Organization administrators have full module access", 422);
    if (input.modulePermissions.some((key) => !isModuleEnabled(organization?.modules, key))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    user.modulePermissions = new Map(input.modulePermissions.map((key) => [key, true]));
    user.modulePermissionsConfigured = true;
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
  await user.save();
  await recordAudit({
    actor,
    action: "user.updated",
    entityType: "user",
    entityId: user._id.toString(),
    organizationId,
    before,
    after: { role: user.role, status: user.status, modulePermissions: Object.fromEntries(user.modulePermissions ?? new Map()), modulePermissionsConfigured: user.modulePermissionsConfigured, passwordReset: Boolean(input.temporaryPassword) },
    meta,
  });
  return presentUser(user);
}

export function isTenantRole(role: string): role is TenantRole {
  return role !== "super_admin";
}
