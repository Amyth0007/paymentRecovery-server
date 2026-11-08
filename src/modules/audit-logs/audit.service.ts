import type { Request } from "express";

type QueryFilter = Record<string, any>;
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AuditLogModel } from "./audit-log.model.js";

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

export async function recordAudit(input: AuditInput): Promise<void> {
  const userAgent = input.meta?.userAgent ?? null;
  await AuditLogModel.create({
    organizationId: input.organizationId ?? input.actor.organizationId,
    actorId: input.actor.userId,
    actorRole: input.actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
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
  const filter: QueryFilter = {};
  if (input.actorRole) {
    filter.actorRole = input.actorRole;
  }
  if (input.organizationId) {
    filter.organizationId = input.organizationId;
  }
  if (input.entityType) {
    filter.entityType = input.entityType;
  }
  if (input.from || input.to) {
    const createdAt: { $gte?: Date; $lt?: Date } = {};
    if (input.from) {
      createdAt.$gte = new Date(`${input.from}T00:00:00.000Z`);
    }
    if (input.to) {
      createdAt.$lt = new Date(`${input.to}T00:00:00.000Z`);
      createdAt.$lt.setUTCDate(createdAt.$lt.getUTCDate() + 1);
    }
    filter.createdAt = createdAt;
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    AuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(input.limit),
    AuditLogModel.countDocuments(filter),
  ]);

  return {
    items: items.map((entry) => ({
      id: entry._id.toString(),
      organizationId: entry.organizationId ? entry.organizationId.toString() : null,
      actorId: entry.actorId.toString(),
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
