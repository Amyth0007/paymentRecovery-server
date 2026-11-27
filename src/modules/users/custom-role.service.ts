import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { and, asc, eq } from "drizzle-orm";
import { isDuplicateKey, isUuid } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import { customRoles, organizations, users } from "../../database/schema.js";
import type { customRoleInputSchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { isModuleEnabled, type ModuleKey } from "../organizations/module-registry.js";
import { organizationModules } from "../organizations/organization.service.js";
import { ACTION_PERMISSIONS, cleanDeniedScreens, ScreenPermissionError } from "./permission-registry.js";

type RoleInput = z.infer<typeof customRoleInputSchema>;
type CustomRoleRow = typeof customRoles.$inferSelect;
function roleView(role: CustomRoleRow) { return { id: role.id, name: role.name, description: role.description, modulePermissions: role.modulePermissions, actionPermissions: role.actionPermissions, deniedScreens: role.deniedScreens ?? [], status: role.status, createdAt: role.createdAt, updatedAt: role.updatedAt }; }

async function validateRole(organizationId: string, input: RoleInput) {
  if (input.modulePermissions.includes("settings")) throw new AppError("VALIDATION_ERROR", "Custom roles cannot manage organization settings or team access", 422);
  const [organization] = isUuid(organizationId)
    ? await db.select({ modules: organizations.modules }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
    : [];
  const modules = organization ? organizationModules(organization.modules) : undefined;
  if (input.modulePermissions.some((module) => !isModuleEnabled(modules, module))) throw new AppError("VALIDATION_ERROR", "Custom roles can only use modules enabled for this organization", 422);
  const moduleSet = new Set(input.modulePermissions);
  if (input.actionPermissions.some((key) => !moduleSet.has(ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module as ModuleKey))) throw new AppError("VALIDATION_ERROR", "Every action must belong to an enabled module selected for this role", 422);
  for (const module of input.modulePermissions) if (!input.actionPermissions.some((key) => ACTION_PERMISSIONS.find((permission) => permission.key === key)?.module === module)) throw new AppError("VALIDATION_ERROR", `Choose at least one action for the ${module} module`, 422);
}

function activeRoleWhere(organizationId: string, roleId: string) {
  return and(eq(customRoles.id, roleId), eq(customRoles.organizationId, organizationId), eq(customRoles.status, "active"));
}

async function findActiveRole(organizationId: string, roleId: string): Promise<CustomRoleRow | null> {
  if (!isUuid(roleId) || !isUuid(organizationId)) return null;
  const [role] = await db.select().from(customRoles).where(activeRoleWhere(organizationId, roleId)).limit(1);
  return role ?? null;
}

export async function listCustomRoles(organizationId: string) {
  return (await db.select().from(customRoles).where(and(eq(customRoles.organizationId, organizationId), eq(customRoles.status, "active"))).orderBy(asc(customRoles.name))).map(roleView);
}

/** Returns the custom role row (`id` instead of the former `_id`). */
export async function getAssignableCustomRole(organizationId: string, roleId: string): Promise<CustomRoleRow> {
  const role = await findActiveRole(organizationId, roleId);
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found in this organization", 404);
  return role;
}

export async function saveCustomRole(actor: AuthContext, organizationId: string, input: RoleInput, id: string | undefined, meta: RequestMeta) {
  await validateRole(organizationId, input);
  let deniedScreens: string[];
  try { deniedScreens = cleanDeniedScreens(input.deniedScreens, input.modulePermissions); }
  catch (error) { if (error instanceof ScreenPermissionError) throw new AppError("VALIDATION_ERROR", error.message, 422); throw error; }
  const previous = id ? await findActiveRole(organizationId, id) : null;
  const values = { name: input.name.trim(), description: (input.description ?? "").trim(), modulePermissions: input.modulePermissions, actionPermissions: input.actionPermissions, deniedScreens };
  let role: CustomRoleRow | null;
  try {
    if (id) {
      role = isUuid(id)
        ? (await db.update(customRoles).set({ ...values, updatedBy: actor.userId }).where(activeRoleWhere(organizationId, id)).returning())[0] ?? null
        : null;
    } else {
      [role] = await db.insert(customRoles).values({ ...values, organizationId, createdBy: actor.userId, updatedBy: actor.userId }).returning();
      role ??= null;
    }
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("CONFLICT", "A custom role with this name already exists", 409);
    throw error;
  }
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found", 404);
  await recordAudit({ actor, action: id ? "user.custom_role_updated" : "user.custom_role_created", entityType: "custom_role", entityId: role.id, organizationId, ...(previous ? { before: roleView(previous) } : {}), after: roleView(role), meta });
  return roleView(role);
}

export async function archiveCustomRole(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  if (!isUuid(id)) throw new AppError("NOT_FOUND", "Active custom role was not found", 404);
  const inUse = await db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, organizationId), eq(users.customRoleId, id))).limit(1);
  if (inUse.length > 0) throw new AppError("CONFLICT", "Reassign everyone using this role before archiving it", 409);
  const [role] = await db.update(customRoles).set({ status: "archived", updatedBy: actor.userId }).where(activeRoleWhere(organizationId, id)).returning();
  if (!role) throw new AppError("NOT_FOUND", "Active custom role was not found", 404);
  await recordAudit({ actor, action: "user.custom_role_archived", entityType: "custom_role", entityId: id, organizationId, after: { status: role.status, name: role.name }, meta });
  return { id, status: role.status };
}
