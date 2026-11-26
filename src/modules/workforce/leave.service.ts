import { and, asc, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { db } from "../../database/connection.js";
import { leaveBalances, leaveRequests, leaveTypes, workforceEmployees } from "../../database/schema.js";
import { accessibleWorkforceEmployeeIds, assertWorkforceEmployeeAccessible } from "./data-scope.js";
import type { leaveRequestSchema, leaveReviewSchema, leaveTypeSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;
type LeaveInput = z.infer<typeof leaveRequestSchema>;

type PopulatedEmployee = { _id: string; employeeNumber: string; firstName: string; lastName: string } | null;
type PopulatedLeaveType = { _id: string; code: string; name: string; paid: boolean } | null;

/** Applies the former Mongoose setters (code uppercase+trim, name trim). */
function normalizeLeaveType<T extends Partial<LeaveTypeInput>>(input: T): T {
  return {
    ...input,
    ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
  };
}

/** Loads `{ _id, employeeNumber, firstName, lastName }` / `{ _id, code, name, paid }` like the former `.populate()` calls. */
async function populateEmployeesAndTypes(employeeIds: string[], leaveTypeIds: string[]) {
  const uniqueEmployeeIds = [...new Set(employeeIds)];
  const uniqueTypeIds = [...new Set(leaveTypeIds)];
  const [employees, types] = await Promise.all([
    uniqueEmployeeIds.length
      ? db.select({ id: workforceEmployees.id, employeeNumber: workforceEmployees.employeeNumber, firstName: workforceEmployees.firstName, lastName: workforceEmployees.lastName }).from(workforceEmployees).where(inArray(workforceEmployees.id, uniqueEmployeeIds))
      : Promise.resolve([]),
    uniqueTypeIds.length
      ? db.select({ id: leaveTypes.id, code: leaveTypes.code, name: leaveTypes.name, paid: leaveTypes.paid }).from(leaveTypes).where(inArray(leaveTypes.id, uniqueTypeIds))
      : Promise.resolve([]),
  ]);
  const employeeMap = new Map<string, PopulatedEmployee>(employees.map((item) => [item.id, { _id: item.id, employeeNumber: item.employeeNumber, firstName: item.firstName, lastName: item.lastName }]));
  const typeMap = new Map<string, PopulatedLeaveType>(types.map((item) => [item.id, { _id: item.id, code: item.code, name: item.name, paid: item.paid }]));
  return {
    employee: (id: string): PopulatedEmployee => employeeMap.get(id) ?? null,
    leaveType: (id: string): PopulatedLeaveType => typeMap.get(id) ?? null,
  };
}

export async function listLeaveTypes(orgId: string, includeBalances = true) {
  if (!includeBalances) {
    const types = await db.select({ id: leaveTypes.id, code: leaveTypes.code, name: leaveTypes.name, paid: leaveTypes.paid, annualEntitlementDays: leaveTypes.annualEntitlementDays, status: leaveTypes.status })
      .from(leaveTypes).where(and(eq(leaveTypes.organizationId, orgId), eq(leaveTypes.status, "active"))).orderBy(asc(leaveTypes.name));
    // Former `.select(...).lean()` result: `_id` plus the selected fields.
    return { types: types.map(({ id, ...rest }) => ({ _id: id, ...rest })), balances: [] };
  }
  const [types, balances] = await Promise.all([
    db.select().from(leaveTypes).where(eq(leaveTypes.organizationId, orgId)).orderBy(asc(leaveTypes.name)),
    db.select().from(leaveBalances).where(eq(leaveBalances.organizationId, orgId)).orderBy(desc(leaveBalances.year)),
  ]);
  const populated = await populateEmployeesAndTypes(balances.map((item) => item.employeeId), balances.map((item) => item.leaveTypeId));
  return {
    types: types.map((item) => ({ id: item.id, code: item.code, name: item.name, paid: item.paid, annualEntitlementDays: item.annualEntitlementDays, status: item.status })),
    balances: balances.map((item) => ({ id: item.id, employee: populated.employee(item.employeeId), leaveType: populated.leaveType(item.leaveTypeId), year: item.year, entitlementDays: item.entitlementDays, usedDays: item.usedDays, availableDays: Math.max(0, item.entitlementDays - item.usedDays) })),
  };
}

export async function createLeaveType(actor: AuthContext, orgId: string, input: LeaveTypeInput, meta: RequestMeta) {
  const [item] = await db.insert(leaveTypes).values({ ...normalizeLeaveType(input), organizationId: orgId }).returning();
  await recordAudit({ actor, action: "leave.type_created", entityType: "leave_type", entityId: item.id, organizationId: orgId, after: input, meta });
  return { id: item.id, ...input };
}

export async function updateLeaveType(actor: AuthContext, orgId: string, id: string, input: LeaveTypeInput, meta: RequestMeta) {
  const [item] = await db.update(leaveTypes).set(normalizeLeaveType(input)).where(and(eq(leaveTypes.id, id), eq(leaveTypes.organizationId, orgId))).returning({ id: leaveTypes.id });
  if (!item) throw new AppError("NOT_FOUND", "Leave type not found", 404);
  await recordAudit({ actor, action: "leave.type_updated", entityType: "leave_type", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteLeaveType(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const [item] = await db.select().from(leaveTypes).where(and(eq(leaveTypes.id, id), eq(leaveTypes.organizationId, orgId))).limit(1);
  if (!item) throw new AppError("NOT_FOUND", "Leave type not found", 404);
  const [requests, balances] = await Promise.all([
    db.select({ id: leaveRequests.id }).from(leaveRequests).where(and(eq(leaveRequests.organizationId, orgId), eq(leaveRequests.leaveTypeId, id))).limit(1),
    db.select({ id: leaveBalances.id }).from(leaveBalances).where(and(eq(leaveBalances.organizationId, orgId), eq(leaveBalances.leaveTypeId, id))).limit(1),
  ]);
  if (requests.length || balances.length) throw new AppError("CONFLICT", "This leave type has employee requests or balance history. Edit it or set it inactive instead.", 409);
  await db.delete(leaveTypes).where(and(eq(leaveTypes.id, id), eq(leaveTypes.organizationId, orgId)));
  await recordAudit({ actor, action: "leave.type_deleted", entityType: "leave_type", entityId: id, organizationId: orgId, before: { code: item.code, name: item.name }, meta });
  return { id, deleted: true };
}

export async function requestLeave(actor: AuthContext, orgId: string, input: LeaveInput, meta: RequestMeta) {
  const [employee] = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.userId, actor.userId), eq(workforceEmployees.status, "active"))).limit(1);
  if (!employee) throw new AppError("NOT_FOUND", "An active employee profile linked to your account is required", 404);
  const start = Date.parse(`${input.startDate}T00:00:00Z`); const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const maxDays = Math.floor((end - start) / 86400000) + 1;
  if (input.days > maxDays) throw new AppError("VALIDATION_ERROR", "Requested leave days exceed the selected calendar date range", 422);
  const year = Number(input.startDate.slice(0, 4));
  if (Number(input.endDate.slice(0, 4)) !== year) throw new AppError("VALIDATION_ERROR", "Submit separate requests for leave spanning calendar years", 422);
  const [leaveType] = await db.select().from(leaveTypes)
    .where(and(eq(leaveTypes.id, input.leaveTypeId), eq(leaveTypes.organizationId, orgId), eq(leaveTypes.status, "active"))).limit(1);
  if (!leaveType) throw new AppError("NOT_FOUND", "Active leave type not found", 404);
  const overlap = await db.select({ id: leaveRequests.id }).from(leaveRequests).where(and(
    eq(leaveRequests.organizationId, orgId),
    eq(leaveRequests.employeeId, employee.id),
    lte(leaveRequests.startDate, input.endDate),
    gte(leaveRequests.endDate, input.startDate),
    inArray(leaveRequests.status, ["pending", "approved"]),
  )).limit(1);
  if (overlap.length) throw new AppError("CONFLICT", "This request overlaps an existing pending or approved leave request", 409);
  // Upsert with "$setOnInsert" semantics: create the balance when missing, never overwrite an existing one.
  await db.insert(leaveBalances).values({ organizationId: orgId, employeeId: employee.id, leaveTypeId: leaveType.id, year, entitlementDays: leaveType.annualEntitlementDays, usedDays: 0 })
    .onConflictDoNothing({ target: [leaveBalances.organizationId, leaveBalances.employeeId, leaveBalances.leaveTypeId, leaveBalances.year] });
  const [balance] = await db.select().from(leaveBalances).where(and(
    eq(leaveBalances.organizationId, orgId), eq(leaveBalances.employeeId, employee.id), eq(leaveBalances.leaveTypeId, leaveType.id), eq(leaveBalances.year, year),
  )).limit(1);
  const [pending] = await db.select({ days: sql<number>`coalesce(sum(${leaveRequests.days}), 0)`.mapWith(Number) }).from(leaveRequests).where(and(
    eq(leaveRequests.organizationId, orgId),
    eq(leaveRequests.employeeId, employee.id),
    eq(leaveRequests.leaveTypeId, leaveType.id),
    eq(leaveRequests.status, "pending"),
    like(leaveRequests.startDate, `${year}%`),
  ));
  const requestedOutstanding = pending?.days ?? 0;
  if (leaveType.paid && balance.entitlementDays - balance.usedDays - requestedOutstanding < input.days) throw new AppError("VALIDATION_ERROR", "This request exceeds the available leave balance", 422);
  const [request] = await db.insert(leaveRequests).values({ ...input, reason: input.reason.trim(), organizationId: orgId, employeeId: employee.id, status: "pending" }).returning();
  await recordAudit({ actor, action: "leave.requested", entityType: "leave_request", entityId: request.id, organizationId: orgId, after: input, meta });
  return { id: request.id, startDate: request.startDate, endDate: request.endDate, days: request.days, status: request.status, leaveType: { id: leaveType.id, name: leaveType.name, paid: leaveType.paid } };
}

export async function listLeaveRequests(orgId: string, employeeId?: string, actor?: AuthContext) {
  const visibleEmployeeIds = actor ? await accessibleWorkforceEmployeeIds(orgId, actor) : null;
  const conditions: (SQL | undefined)[] = [
    eq(leaveRequests.organizationId, orgId),
    visibleEmployeeIds ? (visibleEmployeeIds.length ? inArray(leaveRequests.employeeId, visibleEmployeeIds) : sql`false`) : undefined,
    employeeId ? eq(leaveRequests.employeeId, employeeId) : undefined,
  ];
  const requests = await db.select().from(leaveRequests).where(and(...conditions))
    .orderBy(desc(leaveRequests.startDate), desc(leaveRequests.createdAt)).limit(500);
  const populated = await populateEmployeesAndTypes(requests.map((item) => item.employeeId), requests.map((item) => item.leaveTypeId));
  return requests.map((item) => ({ id: item.id, employee: populated.employee(item.employeeId), leaveType: populated.leaveType(item.leaveTypeId), startDate: item.startDate, endDate: item.endDate, days: item.days, reason: item.reason, status: item.status, reviewedBy: item.reviewedBy ?? null, reviewedAt: item.reviewedAt, reviewComment: item.reviewComment, createdAt: item.createdAt }));
}

export async function listOwnLeaveRequests(actor: AuthContext, orgId: string) {
  const [employee] = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.userId, actor.userId))).limit(1);
  return employee ? listLeaveRequests(orgId, employee.id) : [];
}

export async function reviewLeave(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof leaveReviewSchema>, meta: RequestMeta) {
  const [request] = await db.select().from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.organizationId, orgId), eq(leaveRequests.status, "pending"))).limit(1);
  if (!request) throw new AppError("NOT_FOUND", "Pending leave request not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, request.employeeId);
  const reviewComment = input.comment ?? "";
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(leaveRequests)
      .set({ status: input.decision, reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment })
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.organizationId, orgId), eq(leaveRequests.status, "pending")))
      .returning();
    if (!row) throw new AppError("NOT_FOUND", "Pending leave request not found", 404);
    if (input.decision === "approved") {
      const year = Number(row.startDate.slice(0, 4));
      const [leaveType] = await tx.select({ paid: leaveTypes.paid }).from(leaveTypes)
        .where(and(eq(leaveTypes.id, row.leaveTypeId), eq(leaveTypes.organizationId, orgId))).limit(1);
      if (leaveType?.paid) {
        const balance = await tx.update(leaveBalances)
          .set({ usedDays: sql`${leaveBalances.usedDays} + ${row.days}` })
          .where(and(
            eq(leaveBalances.organizationId, orgId),
            eq(leaveBalances.employeeId, row.employeeId),
            eq(leaveBalances.leaveTypeId, row.leaveTypeId),
            eq(leaveBalances.year, year),
            sql`${leaveBalances.entitlementDays} - ${leaveBalances.usedDays} >= ${row.days}`,
          ))
          .returning({ id: leaveBalances.id });
        // Throwing rolls back the request update, so the request remains pending.
        if (!balance.length) throw new AppError("CONFLICT", "Leave balance changed before approval; request remains pending", 409);
      }
    }
    return row;
  });
  await recordAudit({ actor, action: `leave.request_${input.decision}`, entityType: "leave_request", entityId: id, organizationId: orgId, after: { status: input.decision, comment: input.comment ?? "" }, meta });
  return { id, status: updated.status, reviewComment: updated.reviewComment };
}
