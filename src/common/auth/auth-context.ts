export const ROLES = [
  "super_admin",
  "org_admin",
  "sub_admin",
  "accounts_manager",
  "field_recovery",
  "employee",
  "guard",
] as const;

export type Role = (typeof ROLES)[number];

export const TENANT_ROLES = [
  "org_admin",
  "sub_admin",
  "accounts_manager",
  "field_recovery",
  "employee",
  "guard",
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

/** Team member roles. They follow role defaults until an administrator gives them action-level permissions. */
export const TEAM_MEMBER_ROLES = ["accounts_manager", "field_recovery", "employee", "guard"] as const;

export function isTeamMemberRole(role: string): boolean {
  return (TEAM_MEMBER_ROLES as readonly string[]).includes(role);
}

export type AuthContext = {
  userId: string;
  role: Role;
  organizationId: string | null;
  tokenVersion: number;
  mustChangePassword: boolean;
  /**
   * True when module and action grants are enforced for this user, like for a subadmin: always for
   * subadmins, and for team members an administrator switched to action-level permissions.
   */
  actionScoped?: boolean;
  workforceScope?: { mode: "organization" | "selected"; departmentIds: string[]; locationIds: string[] };
  /** Platform super admin acting inside this organization (see platform impersonation). */
  impersonatorId?: string;
};

export type AuthConfig = {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
  loginRateLimitMax: number;
};

/** Whether action-level permissions (and the workforce data scope) apply to this signed-in user. */
export function usesActionPermissions(actor: Pick<AuthContext, "role" | "actionScoped">): boolean {
  return actor.role === "sub_admin" || (actor.actionScoped === true && isTeamMemberRole(actor.role));
}
