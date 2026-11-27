import type { AuthContext, TenantRole } from "../../common/auth/auth-context.js";
import { hashPassword } from "../../common/auth/password.js";
import { AppError } from "../../common/errors/app-error.js";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { isDuplicateKey, isUuid } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import { customRoles, departments, officeLocations, organizations, users, type BooleanMap, type WorkforceScope } from "../../database/schema.js";
import type { createEmployeeSchema, updateEmployeeSchema, userListQuerySchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { organizationModules } from "../organizations/organization.service.js";
import { isModuleEnabled, MODULES, type ModuleKey } from "../organizations/module-registry.js";
import { revokeAllRefreshTokens } from "../auth/refresh-token.service.js";
import { ACTION_PERMISSIONS, type ActionPermissionKey } from "./permission-registry.js";
import { effectiveUserAccess } from "./user-access.service.js";
import { getAssignableCustomRole } from "./custom-role.service.js";

type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
type ListQuery = z.infer<typeof userListQuerySchema>;

const userSorts = {
  name: asc(users.name),
  "-name": desc(users.name),
  email: asc(users.email),
  "-email": desc(users.email),
  createdAt: asc(users.createdAt),
  "-createdAt": desc(users.createdAt),
} as const;

type UserRow = typeof users.$inferSelect;
type PopulatedCustomRole = { id: string; name: string; modulePermissions: string[]; actionPermissions: string[]; status: string };
const DEFAULT_WORKFORCE_SCOPE: WorkforceScope = { mode: "organization", departmentIds: [], locationIds: [] };

async function findOrganizationModules(organizationId: string): Promise<Map<string, boolean> | undefined> {
  if (!isUuid(organizationId)) return undefined;
  const [organization] = await db.select({ modules: organizations.modules }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return organization ? organizationModules(organization.modules) : undefined;
}

async function assertScopeBelongsToOrganization(organizationId: string, scope: { departmentIds: string[]; locationIds: string[] }) {
  const [departmentCount, locationCount] = await Promise.all([
    scope.departmentIds.length ? db.$count(departments, and(eq(departments.organizationId, organizationId), inArray(departments.id, scope.departmentIds))) : Promise.resolve(0),
    scope.locationIds.length ? db.$count(officeLocations, and(eq(officeLocations.organizationId, organizationId), inArray(officeLocations.id, scope.locationIds))) : Promise.resolve(0),
  ]);
  if (departmentCount !== scope.departmentIds.length || locationCount !== scope.locationIds.length) throw new AppError("VALIDATION_ERROR", "Every scoped department and location must belong to this organization", 422);
}

/**
 * `customRole` reproduces the former `.populate("customRoleId")`: pass `undefined` when the role was not
 * populated, `null` when it was populated but no longer exists, or the role row.
 */
export function presentUser(
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    organizationId?: string | null;
    mustChangePassword: boolean;
    modulePermissions?: BooleanMap | null;
    modulePermissionsConfigured?: boolean;
    actionPermissions?: string[];
    workforceScope?: WorkforceScope | null;
    customRoleId?: string | null;
  },
  customRole?: PopulatedCustomRole | null,
) {
  const populatedCustomRole = customRole ?? null;
  const roleModulePermissions = populatedCustomRole?.status === "active" ? populatedCustomRole.modulePermissions ?? [] : [];
  const roleActionPermissions = populatedCustomRole?.status === "active" ? populatedCustomRole.actionPermissions ?? [] : [];
  const customRoleId = customRole === undefined ? user.customRoleId ?? null : user.customRoleId && customRole ? customRole.id : null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    organizationId: user.organizationId ?? null,
    mustChangePassword: user.mustChangePassword,
    modulePermissions: populatedCustomRole ? Object.fromEntries(roleModulePermissions.map((module) => [module, true])) : user.modulePermissions ?? {},
    modulePermissionsConfigured: populatedCustomRole ? true : user.modulePermissionsConfigured ?? false,
    actionPermissions: populatedCustomRole ? roleActionPermissions : user.actionPermissions ?? [],
    customRoleId,
    customRoleName: populatedCustomRole?.name ?? null,
    workforceScope: user.workforceScope ? { mode: user.workforceScope.mode, departmentIds: [...user.workforceScope.departmentIds], locationIds: [...user.workforceScope.locationIds] } : { mode: "organization", departmentIds: [], locationIds: [] },
  };
}

export async function presentSessionUser(userId: string) {
  const [user] = isUuid(userId) ? await db.select().from(users).where(eq(users.id, userId)).limit(1) : [];
  if (!user) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }
  const [organization] = user.organizationId
    ? await db.select().from(organizations).where(eq(organizations.id, user.organizationId)).limit(1)
    : [];
  const effectiveAccess = user.customRoleId ? await effectiveUserAccess(userId) : null;
  return {
    ...presentUser(user),
    ...(effectiveAccess ? { modulePermissions: Object.fromEntries(effectiveAccess.modules.map((module) => [module, true])), modulePermissionsConfigured: true, actionPermissions: effectiveAccess.actions, customRoleName: effectiveAccess.customRoleName } : {}),
    organization: organization
      ? {
          id: organization.id,
          publicCode: organization.publicCode,
          name: organization.name,
          legalName: organization.legalName,
          address: organization.address,
          status: organization.status,
          timezone: organization.timezone,
          showGuides: organization.showGuides ?? true,
          currency: organization.currency,
          modules: Object.fromEntries(Object.keys(MODULES).map((key) => [key, isModuleEnabled(organizationModules(organization.modules), key as ModuleKey)])),
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
    const organizationModuleMap = await findOrganizationModules(organizationId);
    const customRole = input.customRoleId ? await getAssignableCustomRole(organizationId, input.customRoleId) : null;
    const modulePermissions = customRole?.modulePermissions ?? input.modulePermissions ?? [];
    const actionPermissions = customRole?.actionPermissions ?? input.actionPermissions ?? [];
    if (input.role === "sub_admin" && modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Subadmins cannot be granted organization settings or team administration", 422);
    if (input.role !== "sub_admin" && input.actionPermissions?.length) throw new AppError("VALIDATION_ERROR", "Action permissions are only configurable for subadmins", 422);
    if (!customRole && input.actionPermissions?.some((key) => !modulePermissions.includes(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Action permissions require access to their parent module", 422);
    if (input.role !== "org_admin" && modulePermissions.some((key) => !isModuleEnabled(organizationModuleMap, key as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    if (input.workforceScope?.mode === "selected") {
      await assertScopeBelongsToOrganization(organizationId, input.workforceScope);
    }
    const passwordHash = await hashPassword(input.temporaryPassword);
    const [user] = await db.insert(users).values({
      organizationId,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash,
      role: input.role,
      modulePermissions: input.role !== "org_admin" ? Object.fromEntries(modulePermissions.map((key) => [key, true])) : {},
      modulePermissionsConfigured: input.role !== "org_admin" && (input.modulePermissions !== undefined || Boolean(customRole)),
      actionPermissions: input.role === "sub_admin" ? actionPermissions : [],
      customRoleId: customRole?.id ?? null,
      workforceScope: input.role === "sub_admin" ? input.workforceScope ?? DEFAULT_WORKFORCE_SCOPE : DEFAULT_WORKFORCE_SCOPE,
      status: "active",
      mustChangePassword: false,
      tokenVersion: 0,
    }).returning();
    if (!user) throw new Error("User insert returned no row");
    await recordAudit({
      actor,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      organizationId,
      after: { email: user.email, role: user.role, customRoleId: customRole?.id ?? null, customRoleName: customRole?.name ?? null, modulePermissions: user.modulePermissions ?? {}, actionPermissions: user.actionPermissions ?? [] },
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
  const where = and(eq(users.organizationId, organizationId), query.status ? eq(users.status, query.status) : undefined);
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db
      .select({
        user: users,
        role: { id: customRoles.id, name: customRoles.name, modulePermissions: customRoles.modulePermissions, actionPermissions: customRoles.actionPermissions, status: customRoles.status },
      })
      .from(users)
      .leftJoin(customRoles, eq(customRoles.id, users.customRoleId))
      .where(where)
      .orderBy(userSorts[query.sort], asc(users.id))
      .limit(query.limit)
      .offset(skip),
    db.$count(users, where),
  ]);
  return {
    items: rows.map(({ user, role }) => presentUser(user, role)),
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
  const [found] = isUuid(userId) && isUuid(organizationId)
    ? await db.select().from(users).where(and(eq(users.id, userId), eq(users.organizationId, organizationId))).limit(1)
    : [];
  if (!found) {
    throw new AppError("NOT_FOUND", "Employee was not found", 404);
  }
  const user: UserRow = { ...found };

  const nextRole = input.role ?? user.role;
  const nextStatus = input.status ?? user.status;
  if (user.role === "org_admin" && user.status === "active" && (nextRole !== "org_admin" || nextStatus !== "active")) {
    const otherAdmins = await db.$count(
      users,
      and(eq(users.organizationId, organizationId), eq(users.role, "org_admin"), eq(users.status, "active"), ne(users.id, user.id)),
    );
    if (otherAdmins === 0) {
      throw new AppError("INVALID_STATE", "The organization must keep one active administrator", 422);
    }
  }

  const before = { role: user.role, status: user.status, workforceScope: user.workforceScope, customRoleId: user.customRoleId ?? null, modulePermissions: user.modulePermissions ?? {}, modulePermissionsConfigured: user.modulePermissionsConfigured, actionPermissions: user.actionPermissions ?? [] };
  if (input.workforceScope !== undefined) {
    if (nextRole !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Data scopes can only be assigned to subadmins", 422);
    if (input.workforceScope.mode === "selected") {
      await assertScopeBelongsToOrganization(organizationId, input.workforceScope);
    }
    user.workforceScope = { mode: input.workforceScope.mode, departmentIds: [...input.workforceScope.departmentIds], locationIds: [...input.workforceScope.locationIds] };
  }
  if (input.role) {
    user.role = input.role;
    // Non-subadmins have no data scope; the column keeps its organization-wide default.
    if (input.role !== "sub_admin") user.workforceScope = DEFAULT_WORKFORCE_SCOPE;
    else if (!user.workforceScope) user.workforceScope = DEFAULT_WORKFORCE_SCOPE;
  }
  if (input.status) {
    user.status = input.status;
  }
  if (input.role && input.role === "org_admin") {
    user.modulePermissions = {};
    user.modulePermissionsConfigured = false;
  }
  if (input.role === "sub_admin") {
    const { settings: _settings, ...rest } = user.modulePermissions ?? {};
    user.modulePermissions = rest;
  }
  if (input.role && input.role !== "sub_admin") user.actionPermissions = [];
  if (input.role && input.role !== "sub_admin") user.customRoleId = null;
  let customRoleName: string | null = null;
  if (input.customRoleId !== undefined) {
    if (input.customRoleId === null) user.customRoleId = null;
    else {
      if (user.role !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Custom roles can only be assigned to subadmins", 422);
      const role = await getAssignableCustomRole(organizationId, input.customRoleId);
      user.customRoleId = role.id;
      user.modulePermissions = Object.fromEntries(role.modulePermissions.map((key) => [key, true]));
      user.modulePermissionsConfigured = true;
      user.actionPermissions = role.actionPermissions as ActionPermissionKey[];
      customRoleName = role.name;
    }
  }
  if (input.modulePermissions !== undefined || input.actionPermissions !== undefined) user.customRoleId = null;
  if (input.modulePermissions !== undefined) {
    const organizationModuleMap = await findOrganizationModules(organizationId);
    if (user.role === "org_admin") throw new AppError("VALIDATION_ERROR", "Organization administrators have full module access", 422);
    if (user.role === "sub_admin" && input.modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Subadmins cannot be granted organization settings or team administration", 422);
    if (input.modulePermissions.some((key) => !isModuleEnabled(organizationModuleMap, key))) throw new AppError("VALIDATION_ERROR", "Staff can only be granted screens enabled for this organization", 422);
    user.modulePermissions = Object.fromEntries(input.modulePermissions.map((key) => [key, true]));
    user.modulePermissionsConfigured = true;
    const grantedModules = new Set<string>(input.modulePermissions);
    user.actionPermissions = (user.actionPermissions ?? []).filter((key) => grantedModules.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module ?? ""));
  }
  if (input.actionPermissions !== undefined) {
    if (user.role !== "sub_admin") throw new AppError("VALIDATION_ERROR", "Action permissions are only configurable for subadmins", 422);
    const grantedModules = new Set<string>(input.modulePermissions ?? Object.keys(user.modulePermissions ?? {}));
    if (input.actionPermissions.some((key) => !grantedModules.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)!.module))) throw new AppError("VALIDATION_ERROR", "Action permissions require access to their parent module", 422);
    user.actionPermissions = input.actionPermissions as ActionPermissionKey[];
  }
  if (input.temporaryPassword) {
    user.passwordHash = await hashPassword(input.temporaryPassword);
    user.mustChangePassword = false;
    user.tokenVersion += 1;
    await revokeAllRefreshTokens(user.id);
  }
  if (input.status === "disabled") {
    user.tokenVersion += 1;
    await revokeAllRefreshTokens(user.id);
  }
  const accessRole = user.customRoleId ? await getAssignableCustomRole(organizationId, user.customRoleId).catch(() => null) : null;
  await db
    .update(users)
    .set({
      role: user.role,
      status: user.status,
      workforceScope: user.workforceScope,
      modulePermissions: user.modulePermissions,
      modulePermissionsConfigured: user.modulePermissionsConfigured,
      actionPermissions: user.actionPermissions,
      customRoleId: user.customRoleId,
      passwordHash: user.passwordHash,
      mustChangePassword: user.mustChangePassword,
      tokenVersion: user.tokenVersion,
    })
    .where(eq(users.id, user.id));
  try {
    await recordAudit({
      actor,
      action: "user.updated",
      entityType: "user",
      entityId: user.id,
      organizationId,
      before,
      after: { role: user.role, status: user.status, customRoleId: user.customRoleId ?? null, customRoleName: customRoleName ?? accessRole?.name ?? null, modulePermissions: user.modulePermissions ?? {}, modulePermissionsConfigured: user.modulePermissionsConfigured, actionPermissions: user.actionPermissions ?? [], passwordReset: Boolean(input.temporaryPassword) },
      meta,
    });
  } catch (error) {
    // The user update is already committed. An audit store outage must not report
    // the role change as failed after it has taken effect.
    console.error("Could not record user update audit event", {
      userId: user.id,
      organizationId,
      error,
    });
  }
  return { ...presentUser(user), customRoleName: customRoleName ?? accessRole?.name ?? null };
}

export function isTenantRole(role: string): role is TenantRole {
  return role !== "super_admin";
}
