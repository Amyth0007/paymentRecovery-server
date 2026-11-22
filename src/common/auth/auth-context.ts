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

export type AuthContext = {
  userId: string;
  role: Role;
  organizationId: string | null;
  tokenVersion: number;
  mustChangePassword: boolean;
  workforceScope?: { mode: "organization" | "selected"; departmentIds: string[]; locationIds: string[] };
};

export type AuthConfig = {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
  loginRateLimitMax: number;
};
