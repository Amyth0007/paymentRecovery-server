import type { Request } from "express";
import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { db, type DbOrTx } from "../../database/connection.js";
import { auditLogs } from "../../database/schema.js";

export type RequestMeta = {
  ip: string | null;
  userAgent: string | null;
};

export type AuditInput = {
  actor: AuthContext;
  action: string;
  entityType: string;
  entityId: string;
  organizationId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  meta?: RequestMeta;
};

/** `executor` lets callers record the audit entry inside their own transaction. */
export async function recordAudit(input: AuditInput, executor: DbOrTx = db): Promise<void> {
  const userAgent = input.meta?.userAgent ?? null;
  await executor.insert(auditLogs).values({
    organizationId: input.organizationId ?? input.actor.organizationId ?? null,
    // Actions taken while a platform admin is inside an organization are attributed to that platform admin.
    actorId: input.actor.impersonatorId ?? input.actor.userId,
    actorRole: input.actor.impersonatorId ? "super_admin" : input.actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? (input.actor.impersonatorId ? `Platform admin acting as organization admin ${input.actor.userId}` : null),
    ip: input.meta?.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 300) : null,
  });
}

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.header("user-agent");
  return {
    ip: req.ip ?? null,
    userAgent: userAgent ?? null,
  };
}

export async function listAudits(input: {
  organizationId?: string | null;
  actorRole?: "super_admin";
  entityType?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}) {
  const conditions: SQL[] = [];
  if (input.actorRole) {
    conditions.push(eq(auditLogs.actorRole, input.actorRole));
  }
  if (input.organizationId) {
    conditions.push(eq(auditLogs.organizationId, input.organizationId));
  }
  if (input.entityType) {
    conditions.push(eq(auditLogs.entityType, input.entityType));
  }
  if (input.from) {
    conditions.push(gte(auditLogs.createdAt, new Date(`${input.from}T00:00:00.000Z`)));
  }
  if (input.to) {
    const until = new Date(`${input.to}T00:00:00.000Z`);
    until.setUTCDate(until.getUTCDate() + 1);
    conditions.push(lt(auditLogs.createdAt, until));
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const skip = (input.page - 1) * input.limit;
  const [items, [totalRow]] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(input.limit).offset(skip),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);
  const total = totalRow?.total ?? 0;

  return {
    items: items.map((entry) => ({
      id: entry.id,
      organizationId: entry.organizationId ?? null,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason,
      createdAt: entry.createdAt,
    })),
    meta: { page: input.page, limit: input.limit, total },
  };
}
