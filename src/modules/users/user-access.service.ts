import { and, eq } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { customRoles, users } from "../../database/schema.js";
import { isUuid } from "../../common/utils/db.js";

export type EffectiveUserAccess = { modules: string[]; actions: string[]; customRoleName: string | null };

export async function effectiveUserAccess(userId: string): Promise<EffectiveUserAccess | null> {
  if (!isUuid(userId)) return null;
  const [user] = await db
    .select({
      organizationId: users.organizationId,
      modulePermissions: users.modulePermissions,
      modulePermissionsConfigured: users.modulePermissionsConfigured,
      actionPermissions: users.actionPermissions,
      customRoleId: users.customRoleId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  if (user.customRoleId && user.organizationId) {
    const [role] = await db
      .select({ name: customRoles.name, modulePermissions: customRoles.modulePermissions, actionPermissions: customRoles.actionPermissions })
      .from(customRoles)
      .where(and(eq(customRoles.id, user.customRoleId), eq(customRoles.organizationId, user.organizationId), eq(customRoles.status, "active")))
      .limit(1);
    if (!role) return { modules: [], actions: [], customRoleName: null };
    return { modules: role.modulePermissions, actions: role.actionPermissions, customRoleName: role.name };
  }
  return {
    modules: Object.entries(user.modulePermissions ?? {}).filter(([, enabled]) => enabled).map(([key]) => key),
    actions: user.actionPermissions ?? [],
    customRoleName: null,
  };
}
