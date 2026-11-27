import type { AuthContext } from "../../common/auth/auth-context.js";
import { hashPassword } from "../../common/auth/password.js";
import { AppError } from "../../common/errors/app-error.js";
import { calendarDate } from "../../common/utils/calendar-date.js";
import { isDuplicateKey, isUuid } from "../../common/utils/db.js";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../database/connection.js";
import {
  invoices,
  organizations,
  organizationSubscriptions,
  subscriptionPlans,
  users,
  type BooleanMap,
  type OrganizationSettings,
} from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  createOrganizationSchema,
  createPlanSchema,
  organizationListQuerySchema,
  updateOwnOrganizationSchema,
  updateStatusSchema,
  upsertSubscriptionSchema,
} from "../../common/validators/schemas.js";
import type { z } from "zod";
import { isModuleEnabled, MODULES, type ModuleKey } from "./module-registry.js";

type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
type CreatePlanInput = z.infer<typeof createPlanSchema>;
type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;
type UpdateOwnInput = z.infer<typeof updateOwnOrganizationSchema>;
type ListQuery = z.infer<typeof organizationListQuerySchema>;

const organizationSorts = {
  name: asc(organizations.name),
  "-name": desc(organizations.name),
  createdAt: asc(organizations.createdAt),
  "-createdAt": desc(organizations.createdAt),
} as const;

export type OrganizationRow = typeof organizations.$inferSelect;

/** Adapts the JSONB modules object to the Map shape `isModuleEnabled` expects. */
export function organizationModules(modules: BooleanMap | null | undefined): Map<string, boolean> {
  return new Map(Object.entries(modules ?? {}));
}

async function findOrganization(organizationId: string): Promise<OrganizationRow | null> {
  if (!isUuid(organizationId)) return null;
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return organization ?? null;
}

/** Returns the organization row (`id` instead of the former Mongoose `_id`). */
export async function assertTenantAccessible(organizationId: string): Promise<OrganizationRow> {
  const organization = await findOrganization(organizationId);
  if (!organization) {
    throw new AppError("FORBIDDEN", "Organization access is required", 403);
  }
  if (organization.status !== "active") {
    throw new AppError("TENANT_SUSPENDED", "This organization is not active", 403);
  }
  const [subscription] = await db
    .select({ status: organizationSubscriptions.status })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organization.id))
    .limit(1);
  if (subscription?.status === "cancelled") {
    throw new AppError("TENANT_SUSPENDED", "This organization's subscription is cancelled", 403);
  }
  return organization;
}

function presentSettings(settings: Partial<OrganizationSettings> | null | undefined): OrganizationSettings {
  settings ??= {};
  return {
    acknowledgementEvidenceRequired: settings.acknowledgementEvidenceRequired ?? false,
    pauseRemindersWhenDisputed: settings.pauseRemindersWhenDisputed ?? false,
    reminderSendHourLocal: settings.reminderSendHourLocal ?? 9,
    commitmentGraceDays: settings.commitmentGraceDays ?? 0,
    fieldLocationCapture: settings.fieldLocationCapture ?? "off",
    autoFollowUpOnMissedCommitment: settings.autoFollowUpOnMissedCommitment ?? true,
    navOrder: Array.isArray(settings.navOrder) ? settings.navOrder : [],
  };
}

async function usageFor(organizationId: string) {
  const [userCount, invoiceCount] = await Promise.all([
    db.$count(users, eq(users.organizationId, organizationId)),
    db.$count(invoices, eq(invoices.organizationId, organizationId)),
  ]);
  return { userCount, invoiceCount, storageBytes: 0 };
}

async function subscriptionSummary(organizationId: string) {
  const [subscription] = await db.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.organizationId, organizationId)).limit(1);
  if (!subscription) {
    return null;
  }
  const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, subscription.planId)).limit(1);
  return {
    id: subscription.id,
    status: subscription.status,
    startedOn: subscription.startedOn,
    notes: subscription.notes,
    plan: plan
      ? { id: plan.id, code: plan.code, name: plan.name }
      : null,
  };
}

export async function presentOrganization(organizationId: string) {
  const organization = await findOrganization(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  return {
    id: organization.id,
    publicCode: organization.publicCode,
    name: organization.name,
    legalName: organization.legalName,
    address: organization.address,
    gstin: organization.gstin,
    timezone: organization.timezone,
    showGuides: organization.showGuides ?? true,
    currency: organization.currency,
    status: organization.status,
    modules: Object.fromEntries(Object.keys(MODULES).map((key) => [key, isModuleEnabled(organizationModules(organization.modules), key as ModuleKey)])),
    settings: presentSettings(organization.settings),
    subscription: await subscriptionSummary(organization.id),
    usage: await usageFor(organization.id),
    createdAt: organization.createdAt,
  };
}

export async function updateOrganizationModule(
  actor: AuthContext,
  organizationId: string,
  moduleKey: ModuleKey,
  enabled: boolean,
  meta: RequestMeta,
) {
  const organization = await findOrganization(organizationId);
  if (!organization) throw new AppError("NOT_FOUND", "Organization was not found", 404);
  const before = isModuleEnabled(organizationModules(organization.modules), moduleKey);
  await db
    .update(organizations)
    .set({ modules: { ...(organization.modules ?? {}), [moduleKey]: enabled } })
    .where(eq(organizations.id, organization.id));
  await recordAudit({
    actor,
    action: "organization.module_changed",
    entityType: "organization",
    entityId: organization.id,
    organizationId: organization.id,
    before: { module: moduleKey, enabled: before },
    after: { module: moduleKey, enabled },
    reason: MODULES[moduleKey].name,
    meta,
  });
  return presentOrganization(organization.id);
}

export async function createOrganization(
  actor: AuthContext,
  input: CreateOrganizationInput,
  meta: RequestMeta,
) {
  const passwordHash = await hashPassword(input.admin.temporaryPassword);
  let organizationId: string;
  try {
    organizationId = await db.transaction(async (tx) => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: input.name.trim(),
          legalName: (input.legalName ?? "").trim(),
          gstin: input.gstin ?? null,
          timezone: input.timezone ?? "Asia/Kolkata",
          currency: "INR",
          status: "active",
          createdBy: actor.userId,
        })
        .returning();
      const [admin] = await tx
        .insert(users)
        .values({
          organizationId: organization!.id,
          email: input.admin.email.trim().toLowerCase(),
          name: input.admin.name.trim(),
          passwordHash,
          role: "org_admin",
          status: "active",
          mustChangePassword: false,
          tokenVersion: 0,
        })
        .returning();
      await recordAudit({
        actor,
        action: "organization.created",
        entityType: "organization",
        entityId: organization!.id,
        organizationId: organization!.id,
        after: { name: organization!.name, status: organization!.status },
        meta,
      }, tx);
      await recordAudit({
        actor,
        action: "user.created",
        entityType: "user",
        entityId: admin!.id,
        organizationId: organization!.id,
        after: { email: admin!.email, role: admin!.role },
        meta,
      }, tx);
      return organization!.id;
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A user with this email already exists", 409);
    }
    throw error;
  }

  return presentOrganization(organizationId);
}

export async function listOrganizations(query: ListQuery) {
  const where = query.status ? eq(organizations.status, query.status) : undefined;
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(where).orderBy(organizationSorts[query.sort], asc(organizations.id)).limit(query.limit).offset(skip),
    db.$count(organizations, where),
  ]);
  const items = await Promise.all(rows.map((organization) => presentOrganization(organization.id)));
  return { items, meta: { page: query.page, limit: query.limit, total } };
}

export async function updateOrganizationStatus(
  actor: AuthContext,
  organizationId: string,
  input: UpdateStatusInput,
  meta: RequestMeta,
) {
  const organization = await findOrganization(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const before = organization.status;
  await db.update(organizations).set({ status: input.status }).where(eq(organizations.id, organization.id));
  organization.status = input.status;
  await recordAudit({
    actor,
    action: "organization.status_changed",
    entityType: "organization",
    entityId: organization.id,
    organizationId: organization.id,
    before: { status: before },
    after: { status: organization.status },
    reason: input.reason,
    meta,
  });
  return presentOrganization(organization.id);
}

export async function createPlan(actor: AuthContext, input: CreatePlanInput, meta: RequestMeta) {
  try {
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        code: input.code.trim().toLowerCase(),
        name: input.name.trim(),
        description: input.description ?? "",
        isActive: true,
      })
      .returning();
    if (!plan) throw new Error("Plan insert returned no row");
    await recordAudit({
      actor,
      action: "plan.created",
      entityType: "plan",
      entityId: plan.id,
      organizationId: null,
      after: { code: plan.code, name: plan.name },
      meta,
    });
    return { id: plan.id, code: plan.code, name: plan.name, description: plan.description, isActive: plan.isActive };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A plan with this code already exists", 409);
    }
    throw error;
  }
}

export async function listPlans() {
  const plans = await db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.name));
  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    isActive: plan.isActive,
  }));
}

export async function upsertSubscription(
  actor: AuthContext,
  organizationId: string,
  input: UpsertSubscriptionInput,
  meta: RequestMeta,
) {
  const organization = await findOrganization(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const [plan] = isUuid(input.planId)
    ? await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, input.planId)).limit(1)
    : [];
  if (!plan || !plan.isActive) {
    throw new AppError("INVALID_STATE", "Choose an active plan", 422);
  }
  const [existing] = await db.select().from(organizationSubscriptions).where(eq(organizationSubscriptions.organizationId, organization.id)).limit(1);
  const before = existing ? { status: existing.status, planId: existing.planId } : null;
  if (existing) {
    await db
      .update(organizationSubscriptions)
      .set({ planId: plan.id, status: input.status, ...(input.notes !== undefined ? { notes: input.notes } : {}) })
      .where(eq(organizationSubscriptions.id, existing.id));
  } else {
    await db.insert(organizationSubscriptions).values({
      organizationId: organization.id,
      planId: plan.id,
      status: input.status,
      startedOn: calendarDate(organization.timezone),
      notes: input.notes ?? "",
    });
  }
  await recordAudit({
    actor,
    action: "subscription.updated",
    entityType: "subscription",
    entityId: organization.id,
    organizationId: organization.id,
    before,
    after: { status: input.status, planId: plan.id },
    meta,
  });
  return presentOrganization(organization.id);
}

export async function getOwnOrganization(organizationId: string) {
  return presentOrganization(organizationId);
}

export async function updateOwnOrganization(
  actor: AuthContext,
  organizationId: string,
  input: UpdateOwnInput,
  meta: RequestMeta,
) {
  const organization = await findOrganization(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const before = { name: organization.name, legalName: organization.legalName, address: organization.address, timezone: organization.timezone, gstin: organization.gstin, showGuides: organization.showGuides ?? true };
  if (input.name !== undefined) {
    organization.name = input.name;
  }
  if (input.legalName !== undefined) {
    organization.legalName = input.legalName;
  }
  if (input.address !== undefined) organization.address = input.address;
  if (input.gstin !== undefined) {
    organization.gstin = input.gstin;
  }
  if (input.timezone !== undefined) {
    organization.timezone = input.timezone;
  }
  if (input.showGuides !== undefined) organization.showGuides = input.showGuides;
  if (input.settings) {
    organization.settings = { ...presentSettings(organization.settings), ...input.settings };
  }
  await db
    .update(organizations)
    .set({
      name: organization.name.trim(),
      legalName: organization.legalName.trim(),
      address: organization.address.trim(),
      gstin: organization.gstin,
      timezone: organization.timezone,
      showGuides: organization.showGuides,
      settings: organization.settings,
    })
    .where(eq(organizations.id, organization.id));
  try {
    await recordAudit({
      actor,
      action: "organization.updated",
      entityType: "organization",
      entityId: organization.id,
      organizationId: organization.id,
      before,
      after: { name: organization.name, legalName: organization.legalName, address: organization.address, timezone: organization.timezone, gstin: organization.gstin, showGuides: organization.showGuides },
      meta,
    });
  } catch (error) {
    console.error("Could not record organization update audit event", { organizationId: organization.id, error });
  }
  return presentOrganization(organization.id);
}
