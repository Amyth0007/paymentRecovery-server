import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import type { AuthConfig, AuthContext } from "../../common/auth/auth-context.js";
import { hashPassword } from "../../common/auth/password.js";
import { signImpersonationToken } from "../../common/auth/tokens.js";
import { AppError } from "../../common/errors/app-error.js";
import { isUuid } from "../../common/utils/db.js";
import { loadEnv } from "../../config/env.js";
import { db } from "../../database/connection.js";
import { auditLogs, invoices, organizations, payments, recoveryAssignments, users } from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { revokeAllRefreshTokens } from "../auth/refresh-token.service.js";
import { getAgingBuckets, getCustomerOutstandingReport, getDashboardMetrics } from "../reports/reports.service.js";
import { presentSessionUser } from "../users/user.service.js";
import { assertTenantAccessible } from "./organization.service.js";

/** How long a platform admin's organization session lasts before they must re-enter the master password. */
export const IMPERSONATION_TTL_SECONDS = 2 * 60 * 60;

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function masterPasswordMatches(supplied: string): boolean {
  const configured = loadEnv().MASTER_PASSWORD;
  if (!configured) {
    throw new AppError("FEATURE_DISABLED", "Organization access is disabled. Set MASTER_PASSWORD on the server to enable it.", 503);
  }
  // Compare fixed-length digests so timing does not leak the password length or content.
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

async function primaryAdminFor(organizationId: string) {
  const [admin] = await db
    .select()
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, "org_admin"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return admin ?? null;
}

/** Issues a short-lived organization-admin session for a super admin who supplied the master password. */
export async function impersonateOrganization(actor: AuthContext, organizationId: string, masterPassword: string, config: AuthConfig, meta: RequestMeta) {
  if (actor.role !== "super_admin") throw new AppError("FORBIDDEN", "Only platform admins can open organizations", 403);
  if (!isUuid(organizationId)) throw new AppError("NOT_FOUND", "Organization was not found", 404);
  if (!masterPasswordMatches(masterPassword)) {
    await recordAudit({ actor, action: "platform.impersonation_denied", entityType: "organization", entityId: organizationId, organizationId, meta }).catch(() => undefined);
    throw new AppError("FORBIDDEN", "The master password is incorrect", 403);
  }
  const organization = await assertTenantAccessible(organizationId);
  const admin = await primaryAdminFor(organization.id);
  if (!admin) throw new AppError("INVALID_STATE", "This organization has no active administrator to sign in as", 422);
  const [superAdmin] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!superAdmin) throw new AppError("UNAUTHORIZED", "Authentication is required", 401);

  const accessToken = signImpersonationToken(
    {
      sub: admin.id,
      role: "org_admin",
      organizationId: organization.id,
      tokenVersion: admin.tokenVersion,
      impersonatorId: actor.userId,
      impersonatorTokenVersion: superAdmin.tokenVersion,
    },
    config,
    IMPERSONATION_TTL_SECONDS,
  );
  await recordAudit({
    actor,
    action: "platform.impersonation_started",
    entityType: "organization",
    entityId: organization.id,
    organizationId: organization.id,
    after: { actingAsUserId: admin.id, expiresInSeconds: IMPERSONATION_TTL_SECONDS },
    meta,
  });
  const profile = await presentSessionUser(admin.id);
  return {
    accessToken,
    expiresAt: new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000).toISOString(),
    user: { ...profile, mustChangePassword: false },
  };
}

/** Platform-wide totals and one row of key numbers per organization. */
export async function getPlatformInsights() {
  const since30 = isoDaysAgo(30);
  const activeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [orgRows, userRows, invoiceRows, paymentRows, recoveryRows, activityRows] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name, publicCode: organizations.publicCode, status: organizations.status, createdAt: organizations.createdAt }).from(organizations).orderBy(asc(organizations.name)),
    db
      .select({
        organizationId: users.organizationId,
        total: count(),
        active30d: sql<number>`count(*) filter (where ${users.lastLoginAt} >= ${activeSince.toISOString()})`.mapWith(Number),
        lastLoginAt: max(users.lastLoginAt),
      })
      .from(users)
      .where(sql`${users.organizationId} is not null`)
      .groupBy(users.organizationId),
    db
      .select({
        organizationId: invoices.organizationId,
        issuedCount: sql<number>`count(*) filter (where ${invoices.documentStatus} = 'issued')`.mapWith(Number),
        draftCount: sql<number>`count(*) filter (where ${invoices.documentStatus} = 'draft')`.mapWith(Number),
        outstandingMinor: sql<number>`coalesce(sum(${invoices.outstandingMinor}) filter (where ${invoices.documentStatus} = 'issued'), 0)`.mapWith(Number),
        overdueMinor: sql<number>`coalesce(sum(${invoices.outstandingMinor}) filter (where ${invoices.documentStatus} = 'issued' and ${invoices.outstandingMinor} > 0 and ${invoices.dueDate} < ${isoDaysAgo(0)}), 0)`.mapWith(Number),
        invoicedMinor: sql<number>`coalesce(sum(${invoices.amountMinor}) filter (where ${invoices.documentStatus} = 'issued'), 0)`.mapWith(Number),
      })
      .from(invoices)
      .groupBy(invoices.organizationId),
    db
      .select({
        organizationId: payments.organizationId,
        collected30dMinor: sql<number>`coalesce(sum(case when ${payments.kind} = 'collection' then ${payments.amountMinor} else -${payments.amountMinor} end) filter (where ${payments.paymentDate} >= ${since30}), 0)`.mapWith(Number),
        collectedTotalMinor: sql<number>`coalesce(sum(case when ${payments.kind} = 'collection' then ${payments.amountMinor} else -${payments.amountMinor} end), 0)`.mapWith(Number),
      })
      .from(payments)
      .groupBy(payments.organizationId),
    db
      .select({ organizationId: recoveryAssignments.organizationId, open: count() })
      .from(recoveryAssignments)
      .where(sql`${recoveryAssignments.status} not in ('closed', 'fully_recovered')`)
      .groupBy(recoveryAssignments.organizationId),
    db
      .select({ organizationId: auditLogs.organizationId, lastActivityAt: max(auditLogs.createdAt) })
      .from(auditLogs)
      .where(sql`${auditLogs.organizationId} is not null`)
      .groupBy(auditLogs.organizationId),
  ]);

  const byOrg = <T extends { organizationId: string | null }>(rows: T[]) => new Map(rows.map((row) => [row.organizationId, row]));
  const usersByOrg = byOrg(userRows);
  const invoicesByOrg = byOrg(invoiceRows);
  const paymentsByOrg = byOrg(paymentRows);
  const recoveryByOrg = byOrg(recoveryRows);
  const activityByOrg = byOrg(activityRows);

  const items = orgRows.map((org) => {
    const userStats = usersByOrg.get(org.id);
    const invoiceStats = invoicesByOrg.get(org.id);
    const paymentStats = paymentsByOrg.get(org.id);
    const lastLogin = userStats?.lastLoginAt ? new Date(userStats.lastLoginAt) : null;
    const lastAudit = activityByOrg.get(org.id)?.lastActivityAt ? new Date(activityByOrg.get(org.id)!.lastActivityAt!) : null;
    const lastActivityAt = [lastLogin, lastAudit].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
    const invoicedMinor = invoiceStats?.invoicedMinor ?? 0;
    return {
      id: org.id,
      name: org.name,
      publicCode: org.publicCode,
      status: org.status,
      createdAt: org.createdAt,
      users: userStats?.total ?? 0,
      activeUsers30d: userStats?.active30d ?? 0,
      issuedInvoices: invoiceStats?.issuedCount ?? 0,
      draftInvoices: invoiceStats?.draftCount ?? 0,
      invoicedMinor,
      outstandingMinor: invoiceStats?.outstandingMinor ?? 0,
      overdueMinor: invoiceStats?.overdueMinor ?? 0,
      collected30dMinor: paymentStats?.collected30dMinor ?? 0,
      collectionRate: invoicedMinor > 0 ? Math.max(0, Math.min(1, (invoicedMinor - (invoiceStats?.outstandingMinor ?? 0)) / invoicedMinor)) : null,
      openRecoveries: recoveryByOrg.get(org.id)?.open ?? 0,
      lastActivityAt,
    };
  });

  const totals = items.reduce(
    (sum, item) => ({
      organizations: sum.organizations + 1,
      activeOrganizations: sum.activeOrganizations + (item.status === "active" ? 1 : 0),
      users: sum.users + item.users,
      activeUsers30d: sum.activeUsers30d + item.activeUsers30d,
      issuedInvoices: sum.issuedInvoices + item.issuedInvoices,
      outstandingMinor: sum.outstandingMinor + item.outstandingMinor,
      overdueMinor: sum.overdueMinor + item.overdueMinor,
      collected30dMinor: sum.collected30dMinor + item.collected30dMinor,
    }),
    { organizations: 0, activeOrganizations: 0, users: 0, activeUsers30d: 0, issuedInvoices: 0, outstandingMinor: 0, overdueMinor: 0, collected30dMinor: 0 },
  );

  return { totals, items, masterPasswordConfigured: Boolean(loadEnv().MASTER_PASSWORD) };
}

/** Detailed view of one organization for the platform admin. */
export async function getOrganizationInsights(organizationId: string) {
  if (!isUuid(organizationId)) throw new AppError("NOT_FOUND", "Organization was not found", 404);
  const [organization] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!organization) throw new AppError("NOT_FOUND", "Organization was not found", 404);

  const [metrics, aging, customers, team, roleCounts, recentActivity] = await Promise.all([
    getDashboardMetrics(organizationId),
    getAgingBuckets(organizationId),
    getCustomerOutstandingReport(organizationId),
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), inArray(users.role, ["org_admin"])))
      .orderBy(asc(users.createdAt)),
    db.select({ role: users.role, total: count() }).from(users).where(eq(users.organizationId, organizationId)).groupBy(users.role),
    db
      .select({ id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, actorRole: auditLogs.actorRole, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), gte(auditLogs.createdAt, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))))
      .orderBy(desc(auditLogs.createdAt))
      .limit(12),
  ]);

  return {
    metrics,
    aging,
    topDebtors: customers.filter((customer) => customer.outstandingMinor > 0).slice(0, 5).map((customer) => ({ id: customer.id, displayName: customer.displayName, outstandingMinor: customer.outstandingMinor, overdueMinor: customer.overdueMinor })),
    admins: team,
    usersByRole: Object.fromEntries(roleCounts.map((row) => [row.role, row.total])),
    recentActivity,
  };
}

/** Lets a super admin set a new temporary password for an organization administrator who is locked out. */
export async function resetOrganizationAdminPassword(actor: AuthContext, organizationId: string, userId: string, temporaryPassword: string, meta: RequestMeta) {
  if (!isUuid(organizationId) || !isUuid(userId)) throw new AppError("NOT_FOUND", "Administrator was not found", 404);
  const [admin] = await db
    .select({ id: users.id, tokenVersion: users.tokenVersion })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId), eq(users.role, "org_admin")))
    .limit(1);
  if (!admin) throw new AppError("NOT_FOUND", "Administrator was not found", 404);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: false, tokenVersion: admin.tokenVersion + 1 })
    .where(eq(users.id, admin.id));
  await revokeAllRefreshTokens(admin.id);
  await recordAudit({ actor, action: "platform.admin_password_reset", entityType: "user", entityId: admin.id, organizationId, meta });
  return { reset: true };
}
