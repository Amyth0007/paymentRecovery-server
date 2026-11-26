import { and, asc, count, desc, eq, gt, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { db } from "../../database/connection.js";
import {
  customers,
  fileAssets,
  invoices,
  recoveryAssignments,
  recoveryCallAttempts,
  recoveryVisits,
  users,
} from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  assignmentListQuerySchema,
  createAssignmentSchema,
  createVisitSchema,
  updateAssignmentStatusSchema,
} from "./recovery.schemas.js";

type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
type UpdateStatusInput = z.infer<typeof updateAssignmentStatusSchema>;
type CreateVisitInput = z.infer<typeof createVisitSchema>;
type ListQuery = z.infer<typeof assignmentListQuerySchema>;
type AssignmentRow = typeof recoveryAssignments.$inferSelect;
type VisitRow = typeof recoveryVisits.$inferSelect;

type PopulatedCustomer = { id: string; displayName: string; companyName: string; phone: string };
type PopulatedUser = { id: string; name: string; email?: string };
type PopulatedInvoice = {
  id: string;
  invoiceNumber: string;
  amountMinor: number;
  outstandingMinor: number;
  dueDate: string;
};
type PresentedAssignmentInvoice = {
  id: string;
  invoiceNumber?: string;
  amountMinor?: number;
  outstandingMinor?: number;
  dueDate?: string;
  callAttemptCount?: number;
};

const isScopedToAssignee = (actor: AuthContext) => actor.role === "field_recovery" || actor.role === "employee";

/**
 * Builds the assignment DTO. Pass the populated references to reproduce the old `.populate()` output;
 * populated invoice arrays keep the stored order and drop missing invoices like Mongoose did.
 */
export function presentAssignment(
  assignment: AssignmentRow,
  populated: {
    customer?: PopulatedCustomer | null;
    assignee?: PopulatedUser | null;
    invoices?: Map<string, PopulatedInvoice>;
  } = {},
) {
  const invoiceMap = populated.invoices;
  const presentedInvoices: PresentedAssignmentInvoice[] = invoiceMap
    ? (assignment.invoiceIds ?? [])
        .map((invoiceId) => invoiceMap.get(invoiceId))
        .filter((inv): inv is PopulatedInvoice => Boolean(inv))
        .map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountMinor: inv.amountMinor,
          outstandingMinor: inv.outstandingMinor,
          dueDate: inv.dueDate,
        }))
    : (assignment.invoiceIds ?? []).map((invoiceId) => ({ id: invoiceId }));

  return {
    id: assignment.id,
    customerId: assignment.customerId,
    customer: populated.customer
      ? {
          id: populated.customer.id,
          displayName: populated.customer.displayName,
          companyName: populated.customer.companyName,
          phone: populated.customer.phone,
        }
      : undefined,
    invoices: presentedInvoices,
    outstandingSnapshotMinor: assignment.outstandingSnapshotMinor,
    assigneeId: assignment.assigneeId,
    assignee: populated.assignee
      ? {
          id: populated.assignee.id,
          name: populated.assignee.name,
          email: populated.assignee.email,
        }
      : undefined,
    assignedBy: assignment.assignedBy,
    assignedOn: assignment.assignedOn,
    visitDeadline: assignment.visitDeadline,
    priority: assignment.priority,
    instructions: assignment.instructions ?? "",
    status: assignment.status,
    closeReason: assignment.closeReason ?? null,
    closedAt: assignment.closedAt ?? null,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
  };
}

/**
 * Builds the visit DTO. Pass `employee` to reproduce the populated `employeeId` output and
 * `fileAssetIds` to override the stored ids (populated files drop missing assets).
 */
export function presentVisit(
  visit: VisitRow,
  populated: { employee?: PopulatedUser | null; fileAssetIds?: string[] } = {},
) {
  return {
    id: visit.id,
    assignmentId: visit.assignmentId,
    customerId: visit.customerId,
    employeeId: visit.employeeId,
    employee: populated.employee
      ? {
          id: populated.employee.id,
          name: populated.employee.name,
        }
      : undefined,
    visitedAt: visit.visitedAt,
    contactPersonName: visit.contactPersonName,
    contactDesignation: visit.contactDesignation ?? "",
    outcome: visit.outcome,
    discussion: visit.discussion,
    nonPaymentReason: visit.nonPaymentReason ?? "",
    promisedDate: visit.promisedDate ?? null,
    promisedAmountMinor: visit.promisedAmountMinor ?? null,
    commitmentId: visit.commitmentId ?? null,
    fileAssetIds: populated.fileAssetIds ?? visit.fileAssetIds ?? [],
    location: visit.location ?? null,
    remarks: visit.remarks ?? "",
    createdAt: visit.createdAt,
  };
}

async function loadInvoicesById(invoiceIds: string[]): Promise<Map<string, PopulatedInvoice>> {
  const ids = [...new Set(invoiceIds)];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      amountMinor: invoices.amountMinor,
      outstandingMinor: invoices.outstandingMinor,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(inArray(invoices.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function findScopedAssignment(actor: AuthContext, organizationId: string, assignmentId: string) {
  const conditions: SQL[] = [
    eq(recoveryAssignments.id, assignmentId),
    eq(recoveryAssignments.organizationId, organizationId),
  ];
  if (isScopedToAssignee(actor)) conditions.push(eq(recoveryAssignments.assigneeId, actor.userId));
  const [assignment] = await db
    .select()
    .from(recoveryAssignments)
    .where(and(...conditions))
    .limit(1);
  return assignment ?? null;
}

export async function createAssignment(
  actor: AuthContext,
  organizationId: string,
  input: CreateAssignmentInput,
  meta: RequestMeta,
) {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.id, input.customerId),
        eq(customers.organizationId, organizationId),
        eq(customers.status, "active"),
      ),
    )
    .limit(1);
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found or not active", 404);
  }

  const invoiceRows = await db
    .select({ id: invoices.id, outstandingMinor: invoices.outstandingMinor })
    .from(invoices)
    .where(
      and(
        inArray(invoices.id, input.invoiceIds),
        eq(invoices.organizationId, organizationId),
        eq(invoices.customerId, customer.id),
        eq(invoices.documentStatus, "issued"),
        gt(invoices.outstandingMinor, 0),
      ),
    );

  if (invoiceRows.length !== input.invoiceIds.length) {
    throw new AppError(
      "INVALID_STATE",
      "One or more invoices do not exist, do not belong to customer, or have no outstanding balance",
      422,
    );
  }

  const [assignee] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.assigneeId), eq(users.organizationId, organizationId), eq(users.status, "active")))
    .limit(1);
  if (!assignee) {
    throw new AppError("NOT_FOUND", "Assignee user not found or disabled", 404);
  }

  const outstandingSnapshotMinor = invoiceRows.reduce((sum, inv) => sum + inv.outstandingMinor, 0);

  const [assignment] = await db
    .insert(recoveryAssignments)
    .values({
      organizationId,
      customerId: customer.id,
      invoiceIds: input.invoiceIds,
      outstandingSnapshotMinor,
      assigneeId: assignee.id,
      assignedBy: actor.userId,
      assignedOn: new Date().toISOString().slice(0, 10),
      visitDeadline: input.visitDeadline,
      priority: input.priority,
      instructions: (input.instructions ?? "").trim(),
      status: "assigned",
    })
    .returning();

  await recordAudit({
    actor,
    action: "recovery.assigned",
    entityType: "recovery_assignment",
    entityId: assignment.id,
    organizationId,
    after: {
      customerId: customer.id,
      assigneeId: assignee.id,
      priority: assignment.priority,
    },
    meta,
  });

  return presentAssignment(assignment);
}

export async function updateAssignmentStatus(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
  input: UpdateStatusInput,
  meta: RequestMeta,
) {
  const assignment = await findScopedAssignment(actor, organizationId, assignmentId);
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  if (input.status === "fully_recovered") {
    const linked = assignment.invoiceIds.length
      ? await db
          .select({ outstandingMinor: invoices.outstandingMinor })
          .from(invoices)
          .where(and(inArray(invoices.id, assignment.invoiceIds), eq(invoices.organizationId, organizationId)))
      : [];
    const hasRemaining = linked.some((inv) => inv.outstandingMinor > 0);
    if (hasRemaining) {
      throw new AppError(
        "INVALID_STATE",
        "Cannot mark fully recovered while linked invoices still have outstanding balance",
        422,
      );
    }
  }

  if (input.status === "closed" && !input.closeReason) {
    throw new AppError("VALIDATION_ERROR", "A reason is required to close an assignment", 422);
  }

  const before = { status: assignment.status };

  const changes: Partial<typeof recoveryAssignments.$inferInsert> = { status: input.status };
  if (input.instructions !== undefined) changes.instructions = input.instructions.trim();
  if (input.assigneeId) changes.assigneeId = input.assigneeId;

  if (input.status === "closed") {
    changes.closeReason = input.closeReason ?? "";
    changes.closedAt = new Date();
  }

  const [updated] = await db
    .update(recoveryAssignments)
    .set(changes)
    .where(and(eq(recoveryAssignments.id, assignment.id), eq(recoveryAssignments.organizationId, organizationId)))
    .returning();
  if (!updated) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  await recordAudit({
    actor,
    action: "recovery.status_changed",
    entityType: "recovery_assignment",
    entityId: assignment.id,
    organizationId,
    before,
    after: { status: updated.status },
    reason: input.closeReason,
    meta,
  });

  return presentAssignment(updated);
}

export async function createVisit(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
  input: CreateVisitInput,
  meta: RequestMeta,
) {
  const assignment = await findScopedAssignment(actor, organizationId, assignmentId);
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  // Auto transition assignment status based on visit outcome if appropriate
  let nextStatus: AssignmentRow["status"] | null = null;
  if (input.outcome === "promised_payment") {
    nextStatus = "payment_committed";
  } else if (assignment.status === "assigned" || assignment.status === "visit_scheduled") {
    nextStatus = "visit_completed";
  }

  const visit = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(recoveryVisits)
      .values({
        organizationId,
        assignmentId: assignment.id,
        customerId: assignment.customerId,
        invoiceIds: assignment.invoiceIds,
        employeeId: actor.userId,
        visitedAt: new Date(),
        contactPersonName: input.contactPersonName.trim(),
        contactDesignation: (input.contactDesignation ?? "").trim(),
        outcome: input.outcome,
        discussion: input.discussion.trim(),
        nonPaymentReason: (input.nonPaymentReason ?? "").trim(),
        promisedDate: input.promisedDate ?? null,
        promisedAmountMinor: input.promisedAmountMinor ?? null,
        fileAssetIds: input.fileAssetIds ?? [],
        location: input.location
          ? {
              lat: input.location.lat,
              lng: input.location.lng,
              accuracyMeters: input.location.accuracyMeters ?? null,
            }
          : null,
        remarks: (input.remarks ?? "").trim(),
      })
      .returning();

    if (nextStatus) {
      await tx
        .update(recoveryAssignments)
        .set({ status: nextStatus })
        .where(eq(recoveryAssignments.id, assignment.id));
    }

    return created;
  });

  await recordAudit({
    actor,
    action: "recovery.visit_recorded",
    entityType: "recovery_visit",
    entityId: visit.id,
    organizationId,
    after: { outcome: visit.outcome, contactPersonName: visit.contactPersonName },
    meta,
  });

  return presentVisit(visit);
}

const assignmentSortColumns = {
  visitDeadline: recoveryAssignments.visitDeadline,
  createdAt: recoveryAssignments.createdAt,
} as const;

export async function listAssignments(
  actor: AuthContext,
  organizationId: string,
  query: ListQuery,
) {
  const conditions: SQL[] = [eq(recoveryAssignments.organizationId, organizationId)];

  // Field recovery employees see only assignments given to them
  if (isScopedToAssignee(actor)) {
    conditions.push(eq(recoveryAssignments.assigneeId, actor.userId));
  } else if (query.assigneeId) {
    conditions.push(eq(recoveryAssignments.assigneeId, query.assigneeId));
  }

  if (query.customerId) conditions.push(eq(recoveryAssignments.customerId, query.customerId));
  if (query.status) conditions.push(eq(recoveryAssignments.status, query.status));
  if (query.priority) conditions.push(eq(recoveryAssignments.priority, query.priority));
  if (query.fromDate) {
    conditions.push(gte(recoveryAssignments.createdAt, new Date(`${query.fromDate}T00:00:00.000Z`)));
  }
  if (query.toDate) {
    conditions.push(lte(recoveryAssignments.createdAt, new Date(`${query.toDate}T23:59:59.999Z`)));
  }

  const descending = query.sort.startsWith("-");
  const sortColumn =
    assignmentSortColumns[(descending ? query.sort.slice(1) : query.sort) as keyof typeof assignmentSortColumns];

  const where = and(...conditions);
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db
      .select({
        assignment: recoveryAssignments,
        customer: {
          id: customers.id,
          displayName: customers.displayName,
          companyName: customers.companyName,
          phone: customers.phone,
        },
        assignee: { id: users.id, name: users.name, email: users.email },
      })
      .from(recoveryAssignments)
      .leftJoin(customers, eq(customers.id, recoveryAssignments.customerId))
      .leftJoin(users, eq(users.id, recoveryAssignments.assigneeId))
      .where(where)
      .orderBy(descending ? desc(sortColumn) : asc(sortColumn))
      .limit(query.limit)
      .offset(skip),
    db.$count(recoveryAssignments, where),
  ]);

  const invoiceMap = await loadInvoicesById(rows.flatMap((row) => row.assignment.invoiceIds));

  return {
    items: rows.map((row) =>
      presentAssignment(row.assignment, { customer: row.customer, assignee: row.assignee, invoices: invoiceMap }),
    ),
    meta: { page: query.page, limit: query.limit, total },
  };
}

async function loadVisits(organizationId: string, assignmentId: string) {
  return db
    .select({
      visit: recoveryVisits,
      employee: { id: users.id, name: users.name, email: users.email },
    })
    .from(recoveryVisits)
    .leftJoin(users, eq(users.id, recoveryVisits.employeeId))
    .where(and(eq(recoveryVisits.organizationId, organizationId), eq(recoveryVisits.assignmentId, assignmentId)))
    .orderBy(desc(recoveryVisits.createdAt));
}

export async function getAssignment(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
) {
  const conditions: SQL[] = [
    eq(recoveryAssignments.id, assignmentId),
    eq(recoveryAssignments.organizationId, organizationId),
  ];
  if (isScopedToAssignee(actor)) {
    conditions.push(eq(recoveryAssignments.assigneeId, actor.userId));
  }

  const [row] = await db
    .select({
      assignment: recoveryAssignments,
      customer: {
        id: customers.id,
        displayName: customers.displayName,
        companyName: customers.companyName,
        phone: customers.phone,
      },
      assignee: { id: users.id, name: users.name, email: users.email },
    })
    .from(recoveryAssignments)
    .leftJoin(customers, eq(customers.id, recoveryAssignments.customerId))
    .leftJoin(users, eq(users.id, recoveryAssignments.assigneeId))
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new AppError("NOT_FOUND", "Assignment not found", 404);
  }
  const assignment = row.assignment;

  const [invoiceMap, visits, callAttemptCounts] = await Promise.all([
    loadInvoicesById(assignment.invoiceIds),
    loadVisits(organizationId, assignment.id),
    db
      .select({ invoiceId: recoveryCallAttempts.invoiceId, count: count() })
      .from(recoveryCallAttempts)
      .where(
        and(
          eq(recoveryCallAttempts.organizationId, assignment.organizationId),
          eq(recoveryCallAttempts.assignmentId, assignment.id),
        ),
      )
      .groupBy(recoveryCallAttempts.invoiceId),
  ]);

  // Populate visit files (missing assets are dropped, as Mongoose populate did).
  const visitFileIds = [...new Set(visits.flatMap(({ visit }) => visit.fileAssetIds))];
  const existingFiles = visitFileIds.length
    ? await db.select({ id: fileAssets.id }).from(fileAssets).where(inArray(fileAssets.id, visitFileIds))
    : [];
  const existingFileIds = new Set(existingFiles.map((file) => file.id));

  const countsByInvoiceId = new Map(callAttemptCounts.map((entry) => [entry.invoiceId, Number(entry.count)]));
  const presentedAssignment = presentAssignment(assignment, {
    customer: row.customer,
    assignee: row.assignee,
    invoices: invoiceMap,
  });
  presentedAssignment.invoices = presentedAssignment.invoices.map((invoice) => ({
    ...invoice,
    callAttemptCount: countsByInvoiceId.get(invoice.id) ?? 0,
  }));

  return {
    assignment: presentedAssignment,
    visits: visits.map(({ visit, employee }) =>
      presentVisit(visit, {
        employee,
        fileAssetIds: visit.fileAssetIds.filter((fileId) => existingFileIds.has(fileId)),
      }),
    ),
  };
}

export async function createCallAttempt(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
  invoiceId: string,
  meta: RequestMeta,
) {
  const assignment = await findScopedAssignment(actor, organizationId, assignmentId);
  if (!assignment) throw new AppError("NOT_FOUND", "Assignment not found", 404);
  if (!assignment.invoiceIds.includes(invoiceId)) {
    throw new AppError("NOT_FOUND", "Invoice is not part of this recovery assignment", 404);
  }

  const [customer] = await db
    .select({ phone: customers.phone })
    .from(customers)
    .where(and(eq(customers.id, assignment.customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  const phone = customer?.phone.trim() ?? "";
  const dialablePhone = phone.replace(/[^\d+]/g, "");
  if (dialablePhone.replace(/\D/g, "").length < 5) {
    throw new AppError("INVALID_STATE", "Add a valid customer phone number before calling", 422);
  }

  const [attempt] = await db
    .insert(recoveryCallAttempts)
    .values({
      organizationId,
      assignmentId: assignment.id,
      invoiceId,
      customerId: assignment.customerId,
      employeeId: actor.userId,
      attemptedAt: new Date(),
    })
    .returning();
  const callAttemptCount = await db.$count(
    recoveryCallAttempts,
    and(
      eq(recoveryCallAttempts.organizationId, organizationId),
      eq(recoveryCallAttempts.assignmentId, assignmentId),
      eq(recoveryCallAttempts.invoiceId, invoiceId),
    ),
  );
  await recordAudit({
    actor,
    action: "recovery.customer_call_attempted",
    entityType: "recovery_call_attempt",
    entityId: attempt.id,
    organizationId,
    after: { assignmentId, invoiceId, callAttemptCount },
    meta,
  });
  return { invoiceId, callAttemptCount, phone: dialablePhone, attemptedAt: attempt.attemptedAt };
}

export async function listVisits(actor: AuthContext, organizationId: string, assignmentId: string) {
  const assignment = await findScopedAssignment(actor, organizationId, assignmentId);
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  const visits = await loadVisits(organizationId, assignment.id);
  return visits.map(({ visit, employee }) => presentVisit(visit, { employee }));
}
