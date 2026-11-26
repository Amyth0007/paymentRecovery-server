import { z } from "zod";
import { TENANT_ROLES } from "../../common/auth/auth-context.js";
import { isValidTimeZone } from "../../common/utils/calendar-date.js";
import { MODULES } from "../../modules/organizations/module-registry.js";
import { ACTION_PERMISSION_KEYS } from "../../modules/users/permission-registry.js";

/** Record identifiers are PostgreSQL UUIDs (the name is kept from the MongoDB era to avoid churn). */
export const objectIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid id");

export const passwordSchema = z.string().min(8).max(128);

const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, "Invalid GSTIN");

const timezoneSchema = z.string().trim().refine(isValidTimeZone, "Invalid timezone");

export const settingsSchema = z.object({
  acknowledgementEvidenceRequired: z.boolean().optional(),
  pauseRemindersWhenDisputed: z.boolean().optional(),
  reminderSendHourLocal: z.number().int().min(0).max(23).optional(),
  commitmentGraceDays: z.number().int().min(0).max(365).optional(),
  fieldLocationCapture: z.enum(["off", "optional"]).optional(),
  autoFollowUpOnMissedCommitment: z.boolean().optional(),
});

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  legalName: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  gstin: gstinSchema.optional(),
  timezone: timezoneSchema.optional(),
  admin: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.email().trim().toLowerCase(),
    temporaryPassword: passwordSchema,
  }),
});

export const updateStatusSchema = z.object({
  status: z.enum(["active", "suspended", "deactivated"]),
  reason: z.string().trim().min(3).max(500),
});

export const moduleKeySchema = z.enum(Object.keys(MODULES) as [keyof typeof MODULES, ...(keyof typeof MODULES)[]]);
export const updateModuleSchema = z.object({ enabled: z.boolean() });

export const customRoleInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(""),
  modulePermissions: z.array(moduleKeySchema).min(1).max(30),
  actionPermissions: z.array(z.enum(ACTION_PERMISSION_KEYS)).min(1).max(100),
}).refine((value) => new Set(value.modulePermissions).size === value.modulePermissions.length && new Set(value.actionPermissions).size === value.actionPermissions.length, { message: "Modules and actions must not contain duplicates" });

export const createPlanSchema = z.object({
  code: z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

export const upsertSubscriptionSchema = z.object({
  planId: objectIdSchema,
  status: z.enum(["trial", "active", "past_due", "cancelled"]),
  notes: z.string().trim().max(500).optional(),
});

export const updateOwnOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  legalName: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  gstin: gstinSchema.nullable().optional(),
  timezone: timezoneSchema.optional(),
  showGuides: z.boolean().optional(),
  settings: settingsSchema.optional(),
});

export const organizationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["name", "-name", "createdAt", "-createdAt"]).default("name"),
  status: z.enum(["active", "suspended", "deactivated"]).optional(),
});

export const workforceScopeSchema = z.object({ mode: z.enum(["organization", "selected"]).default("organization"), departmentIds: z.array(objectIdSchema).max(100).default([]), locationIds: z.array(objectIdSchema).max(100).default([]) }).refine((scope) => scope.mode !== "selected" || scope.departmentIds.length > 0 || scope.locationIds.length > 0, { message: "Choose at least one department or work location for a restricted scope" }).refine((scope) => new Set(scope.departmentIds).size === scope.departmentIds.length && new Set(scope.locationIds).size === scope.locationIds.length, { message: "Scope selections must not contain duplicates" });

export const createEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase(),
  role: z.enum(TENANT_ROLES),
  temporaryPassword: passwordSchema,
  modulePermissions: z.array(moduleKeySchema).optional(),
  actionPermissions: z.array(z.enum(ACTION_PERMISSION_KEYS)).optional(),
  customRoleId: objectIdSchema.nullable().optional(),
  workforceScope: workforceScopeSchema.optional(),
}).refine((value) => !value.workforceScope || value.role === "sub_admin", { message: "Data scopes can only be assigned to subadmins", path: ["workforceScope"] }).refine((value) => !value.customRoleId || (value.role === "sub_admin" && !value.modulePermissions?.length && !value.actionPermissions?.length), { message: "Custom roles can only be assigned to subadmins without separate permission overrides", path: ["customRoleId"] });

export const updateEmployeeSchema = z
  .object({
    role: z.enum(TENANT_ROLES).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    temporaryPassword: passwordSchema.optional(),
    modulePermissions: z.array(moduleKeySchema).optional(),
    actionPermissions: z.array(z.enum(ACTION_PERMISSION_KEYS)).optional(),
    customRoleId: objectIdSchema.nullable().optional(),
    workforceScope: workforceScopeSchema.optional(),
  })
  .refine((value) => value.workforceScope === undefined || value.role === undefined || value.role === "sub_admin", { message: "Data scopes can only be assigned to subadmins", path: ["workforceScope"] })
  .refine((value) => !value.customRoleId || (value.role === undefined || value.role === "sub_admin") , { message: "Custom roles are only available to subadmins", path: ["customRoleId"] })
  .refine((value) => value.customRoleId === undefined || value.modulePermissions === undefined && value.actionPermissions === undefined, { message: "Custom roles cannot be combined with separate permission overrides", path: ["customRoleId"] })
  .refine((value) => value.role !== undefined || value.status !== undefined || value.temporaryPassword !== undefined || value.modulePermissions !== undefined || value.actionPermissions !== undefined || value.customRoleId !== undefined || value.workforceScope !== undefined, {
    message: "No changes were provided",
  });

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["name", "-name", "email", "-email", "createdAt", "-createdAt"]).default("name"),
  status: z.enum(["active", "disabled"]).optional(),
});

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  entityType: z
    .enum([
      "organization",
      "user",
      "subscription",
      "plan",
      "customer",
      "invoice",
      "payment",
      "recovery_assignment",
      "recovery_visit",
      "commitment",
      "file",
    ])
    .optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
