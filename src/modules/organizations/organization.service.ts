import type { AuthContext } from "../../common/auth/auth-context.js";
import { hashPassword } from "../../common/auth/password.js";
import { AppError } from "../../common/errors/app-error.js";
import { calendarDate } from "../../common/utils/calendar-date.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { UserModel } from "../users/user.model.js";
import type {
  createOrganizationSchema,
  createPlanSchema,
  organizationListQuerySchema,
  updateOwnOrganizationSchema,
  updateStatusSchema,
  upsertSubscriptionSchema,
} from "../../common/validators/schemas.js";
import type { z } from "zod";
import {
  OrganizationModel,
  OrganizationSubscriptionModel,
  SubscriptionPlanModel,
} from "./organization.model.js";
import { MODULES, type ModuleKey } from "./module-registry.js";

type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
type CreatePlanInput = z.infer<typeof createPlanSchema>;
type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;
type UpdateOwnInput = z.infer<typeof updateOwnOrganizationSchema>;
type ListQuery = z.infer<typeof organizationListQuerySchema>;

const organizationSorts = {
  name: { name: 1 },
  "-name": { name: -1 },
  createdAt: { createdAt: 1 },
  "-createdAt": { createdAt: -1 },
} as const;

export async function assertTenantAccessible(organizationId: string) {
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) {
    throw new AppError("FORBIDDEN", "Organization access is required", 403);
  }
  if (organization.status !== "active") {
    throw new AppError("TENANT_SUSPENDED", "This organization is not active", 403);
  }
  const subscription = await OrganizationSubscriptionModel.findOne({
    organizationId: organization._id,
  });
  if (subscription?.status === "cancelled") {
    throw new AppError("TENANT_SUSPENDED", "This organization's subscription is cancelled", 403);
  }
  return organization;
}

function presentSettings(settings: {
  acknowledgementEvidenceRequired?: boolean;
  pauseRemindersWhenDisputed?: boolean;
  reminderSendHourLocal?: number;
  commitmentGraceDays?: number;
  fieldLocationCapture?: "off" | "optional";
  autoFollowUpOnMissedCommitment?: boolean;
}) {
  return {
    acknowledgementEvidenceRequired: settings.acknowledgementEvidenceRequired ?? false,
    pauseRemindersWhenDisputed: settings.pauseRemindersWhenDisputed ?? false,
    reminderSendHourLocal: settings.reminderSendHourLocal ?? 9,
    commitmentGraceDays: settings.commitmentGraceDays ?? 0,
    fieldLocationCapture: settings.fieldLocationCapture ?? "off",
    autoFollowUpOnMissedCommitment: settings.autoFollowUpOnMissedCommitment ?? true,
  };
}

async function usageFor(organizationId: string) {
  const userCount = await UserModel.countDocuments({ organizationId });
  return { userCount, invoiceCount: 0, storageBytes: 0 };
}

async function subscriptionSummary(organizationId: string) {
  const subscription = await OrganizationSubscriptionModel.findOne({ organizationId });
  if (!subscription) {
    return null;
  }
  const plan = await SubscriptionPlanModel.findById(subscription.planId);
  return {
    id: subscription._id.toString(),
    status: subscription.status,
    startedOn: subscription.startedOn,
    notes: subscription.notes,
    plan: plan
      ? { id: plan._id.toString(), code: plan.code, name: plan.name }
      : null,
  };
}

export async function presentOrganization(organizationId: string) {
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  return {
    id: organization._id.toString(),
    name: organization.name,
    legalName: organization.legalName,
    gstin: organization.gstin,
    timezone: organization.timezone,
    currency: organization.currency,
    status: organization.status,
    modules: Object.fromEntries(Object.keys(MODULES).map((key) => [key, organization.modules?.get(key) === true])),
    settings: presentSettings(organization.settings),
    subscription: await subscriptionSummary(organization._id.toString()),
    usage: await usageFor(organization._id.toString()),
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
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) throw new AppError("NOT_FOUND", "Organization was not found", 404);
  const before = organization.modules?.get(moduleKey) === true;
  organization.modules ??= new Map<string, boolean>();
  organization.modules.set(moduleKey, enabled);
  organization.markModified("modules");
  await organization.save();
  await recordAudit({
    actor,
    action: "organization.module_changed",
    entityType: "organization",
    entityId: organization._id.toString(),
    organizationId: organization._id.toString(),
    before: { module: moduleKey, enabled: before },
    after: { module: moduleKey, enabled },
    reason: MODULES[moduleKey].name,
    meta,
  });
  return presentOrganization(organization._id.toString());
}

export async function createOrganization(
  actor: AuthContext,
  input: CreateOrganizationInput,
  meta: RequestMeta,
) {
  const organization = await OrganizationModel.create({
    name: input.name,
    legalName: input.legalName ?? "",
    gstin: input.gstin ?? null,
    timezone: input.timezone ?? "Asia/Kolkata",
    currency: "INR",
    status: "active",
    createdBy: actor.userId,
  });

  try {
    const passwordHash = await hashPassword(input.admin.temporaryPassword);
    const admin = await UserModel.create({
      organizationId: organization._id,
      email: input.admin.email,
      name: input.admin.name,
      passwordHash,
      role: "org_admin",
      status: "active",
      mustChangePassword: false,
      tokenVersion: 0,
    });
    await recordAudit({
      actor,
      action: "organization.created",
      entityType: "organization",
      entityId: organization._id.toString(),
      organizationId: organization._id.toString(),
      after: { name: organization.name, status: organization.status },
      meta,
    });
    await recordAudit({
      actor,
      action: "user.created",
      entityType: "user",
      entityId: admin._id.toString(),
      organizationId: organization._id.toString(),
      after: { email: admin.email, role: admin.role },
      meta,
    });
  } catch (error) {
    await UserModel.deleteMany({ organizationId: organization._id });
    await OrganizationModel.deleteOne({ _id: organization._id });
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A user with this email already exists", 409);
    }
    throw error;
  }

  return presentOrganization(organization._id.toString());
}

export async function listOrganizations(query: ListQuery) {
  const filter = query.status ? { status: query.status } : {};
  const skip = (query.page - 1) * query.limit;
  const [organizations, total] = await Promise.all([
    OrganizationModel.find(filter).sort(organizationSorts[query.sort]).skip(skip).limit(query.limit),
    OrganizationModel.countDocuments(filter),
  ]);
  const items = await Promise.all(organizations.map((organization) => presentOrganization(organization._id.toString())));
  return { items, meta: { page: query.page, limit: query.limit, total } };
}

export async function updateOrganizationStatus(
  actor: AuthContext,
  organizationId: string,
  input: UpdateStatusInput,
  meta: RequestMeta,
) {
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const before = organization.status;
  organization.status = input.status;
  await organization.save();
  await recordAudit({
    actor,
    action: "organization.status_changed",
    entityType: "organization",
    entityId: organization._id.toString(),
    organizationId: organization._id.toString(),
    before: { status: before },
    after: { status: organization.status },
    reason: input.reason,
    meta,
  });
  return presentOrganization(organization._id.toString());
}

export async function createPlan(actor: AuthContext, input: CreatePlanInput, meta: RequestMeta) {
  try {
    const plan = await SubscriptionPlanModel.create({
      code: input.code,
      name: input.name,
      description: input.description ?? "",
      isActive: true,
    });
    await recordAudit({
      actor,
      action: "plan.created",
      entityType: "plan",
      entityId: plan._id.toString(),
      organizationId: null,
      after: { code: plan.code, name: plan.name },
      meta,
    });
    return { id: plan._id.toString(), code: plan.code, name: plan.name, description: plan.description, isActive: plan.isActive };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A plan with this code already exists", 409);
    }
    throw error;
  }
}

export async function listPlans() {
  const plans = await SubscriptionPlanModel.find().sort({ name: 1 });
  return plans.map((plan) => ({
    id: plan._id.toString(),
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
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const plan = await SubscriptionPlanModel.findById(input.planId);
  if (!plan || !plan.isActive) {
    throw new AppError("INVALID_STATE", "Choose an active plan", 422);
  }
  const existing = await OrganizationSubscriptionModel.findOne({ organizationId: organization._id });
  const before = existing ? { status: existing.status, planId: existing.planId.toString() } : null;
  if (existing) {
    existing.planId = plan._id;
    existing.status = input.status;
    if (input.notes !== undefined) {
      existing.notes = input.notes;
    }
    await existing.save();
  } else {
    await OrganizationSubscriptionModel.create({
      organizationId: organization._id,
      planId: plan._id,
      status: input.status,
      startedOn: calendarDate(organization.timezone),
      notes: input.notes ?? "",
    });
  }
  await recordAudit({
    actor,
    action: "subscription.updated",
    entityType: "subscription",
    entityId: organization._id.toString(),
    organizationId: organization._id.toString(),
    before,
    after: { status: input.status, planId: plan._id.toString() },
    meta,
  });
  return presentOrganization(organization._id.toString());
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
  const organization = await OrganizationModel.findById(organizationId);
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization was not found", 404);
  }
  const before = { name: organization.name, timezone: organization.timezone, gstin: organization.gstin };
  if (input.name !== undefined) {
    organization.name = input.name;
  }
  if (input.legalName !== undefined) {
    organization.legalName = input.legalName;
  }
  if (input.gstin !== undefined) {
    organization.gstin = input.gstin;
  }
  if (input.timezone !== undefined) {
    organization.timezone = input.timezone;
  }
  if (input.settings) {
    organization.settings = { ...presentSettings(organization.settings), ...input.settings };
    organization.markModified("settings");
  }
  await organization.save();
  await recordAudit({
    actor,
    action: "organization.updated",
    entityType: "organization",
    entityId: organization._id.toString(),
    organizationId: organization._id.toString(),
    before,
    after: { name: organization.name, timezone: organization.timezone, gstin: organization.gstin },
    meta,
  });
  return presentOrganization(organization._id.toString());
}
