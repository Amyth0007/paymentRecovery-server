import { z } from "zod";
import { TENANT_ROLES } from "../../common/auth/auth-context.js";
import { isValidTimeZone } from "../../common/utils/calendar-date.js";

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

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
  gstin: gstinSchema.nullable().optional(),
  timezone: timezoneSchema.optional(),
  settings: settingsSchema.optional(),
});

export const organizationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["name", "-name", "createdAt", "-createdAt"]).default("name"),
  status: z.enum(["active", "suspended", "deactivated"]).optional(),
});

export const createEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase(),
  role: z.enum(TENANT_ROLES),
  temporaryPassword: passwordSchema,
});

export const updateEmployeeSchema = z
  .object({
    role: z.enum(TENANT_ROLES).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    temporaryPassword: passwordSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined || value.temporaryPassword !== undefined, {
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
