import { UserModel } from "./user.model.js";
import { CustomRoleModel } from "./custom-role.model.js";

export type EffectiveUserAccess = { modules: string[]; actions: string[]; customRoleName: string | null };

export async function effectiveUserAccess(userId: string): Promise<EffectiveUserAccess | null> {
  const user = await UserModel.findById(userId).select("organizationId modulePermissions modulePermissionsConfigured actionPermissions customRoleId").lean();
  if (!user) return null;
  if (user.customRoleId && user.organizationId) {
    const role = await CustomRoleModel.findOne({ _id: user.customRoleId, organizationId: user.organizationId, status: "active" }).select("name modulePermissions actionPermissions").lean();
    if (!role) return { modules: [], actions: [], customRoleName: null };
    return { modules: role.modulePermissions, actions: role.actionPermissions, customRoleName: role.name };
  }
  return {
    modules: user.modulePermissions instanceof Map ? [...user.modulePermissions.entries()].filter(([, enabled]) => enabled).map(([key]) => key) : Object.entries(user.modulePermissions ?? {}).filter(([, enabled]) => enabled).map(([key]) => key),
    actions: user.actionPermissions ?? [],
    customRoleName: null,
  };
}
