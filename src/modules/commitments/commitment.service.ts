import { and, arrayContains, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { db } from "../../database/connection.js";
import {
  commitments,
  customers,
  invoices,
  recoveryAssignments,
  recoveryVisits,
} from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  cancelCommitmentSchema,
  commitmentListQuerySchema,
  createCommitmentSchema,
  evaluateCommitmentSchema,
} from "./commitment.schemas.js";

type CreateInput = z.infer<typeof createCommitmentSchema>;
type CancelInput = z.infer<typeof cancelCommitmentSchema>;
type EvaluateInput = z.infer<typeof evaluateCommitmentSchema>;
type ListQuery = z.infer<typeof commitmentListQuerySchema>;
type CommitmentRow = typeof commitments.$inferSelect;

type PopulatedCustomer = { id: string; displayName: string; companyName: string };
type PopulatedInvoice = { id: string; invoiceNumber: string; amountMinor: number; outstandingMinor: number };

/**
 * Builds the commitment DTO. Pass `populated.invoices` (a Map by id) to reproduce the old populated
 * `invoiceIds` output; missing invoices are dropped like Mongoose populate did.
 */
export function presentCommitment(
  c: CommitmentRow,
  populated: { customer?: PopulatedCustomer | null; invoices?: Map<string, PopulatedInvoice> } = {},
) {
  const invoiceMap = populated.invoices;
  return {
    id: c.id,
    customerId: c.customerId,
    customer: populated.customer
      ? {
          id: populated.customer.id,
          displayName: populated.customer.displayName,
          companyName: populated.customer.companyName,
        }
      : undefined,
    invoices: invoiceMap
      ? (c.invoiceIds ?? [])
          .map((invoiceId) => invoiceMap.get(invoiceId))
          .filter((inv): inv is PopulatedInvoice => Boolean(inv))
          .map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amountMinor: inv.amountMinor,
            outstandingMinor: inv.outstandingMinor,
          }))
      : (c.invoiceIds ?? []).map((invoiceId) => ({ id: invoiceId })),
    promisedAmountMinor: c.promisedAmountMinor,
    promisedDate: c.promisedDate,
    delayReason: c.delayReason ?? "",
    responsiblePerson: c.responsiblePerson,
    recordedBy: c.recordedBy,
    fileAssetIds: c.fileAssetIds ?? [],
    sourceVisitId: c.sourceVisitId ?? null,
    status: c.status,
    fulfilledAmountMinor: c.fulfilledAmountMinor ?? 0,
    evaluatedAt: c.evaluatedAt ?? null,
    cancelReason: c.cancelReason ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
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
    })
    .from(invoices)
    .where(inArray(invoices.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function findCommitment(organizationId: string, commitmentId: string) {
  const [commitment] = await db
    .select()
    .from(commitments)
    .where(and(eq(commitments.id, commitmentId), eq(commitments.organizationId, organizationId)))
    .limit(1);
  if (!commitment) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }
  return commitment;
}

export async function createCommitment(
  actor: AuthContext,
  organizationId: string,
  input: CreateInput,
  meta: RequestMeta,
) {
  if (actor.role === "field_recovery") {
    const [assignment] = await db
      .select({ id: recoveryAssignments.id })
      .from(recoveryAssignments)
      .where(
        and(
          eq(recoveryAssignments.organizationId, organizationId),
          eq(recoveryAssignments.assigneeId, actor.userId),
          eq(recoveryAssignments.customerId, input.customerId),
          arrayContains(recoveryAssignments.invoiceIds, input.invoiceIds),
        ),
      )
      .limit(1);
    if (!assignment) {
      throw new AppError("FORBIDDEN", "Commitments can only be recorded for your assigned recovery work", 403);
    }
    if (input.sourceVisitId) {
      const visit = await db
        .select({ id: recoveryVisits.id })
        .from(recoveryVisits)
        .where(
          and(
            eq(recoveryVisits.id, input.sourceVisitId),
            eq(recoveryVisits.organizationId, organizationId),
            eq(recoveryVisits.assignmentId, assignment.id),
            eq(recoveryVisits.employeeId, actor.userId),
          ),
        )
        .limit(1);
      if (!visit.length) {
        throw new AppError("FORBIDDEN", "The selected visit does not belong to your assigned work", 403);
      }
    }
  }

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

  const matchingInvoices = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        inArray(invoices.id, input.invoiceIds),
        eq(invoices.organizationId, organizationId),
        eq(invoices.customerId, customer.id),
        eq(invoices.documentStatus, "issued"),
      ),
    );
  if (matchingInvoices.length !== input.invoiceIds.length) {
    throw new AppError("INVALID_STATE", "One or more invoices do not belong to this customer", 422);
  }

  const [commitment] = await db
    .insert(commitments)
    .values({
      organizationId,
      customerId: customer.id,
      invoiceIds: input.invoiceIds,
      promisedAmountMinor: input.promisedAmountMinor,
      promisedDate: input.promisedDate,
      delayReason: (input.delayReason ?? "").trim(),
      responsiblePerson: input.responsiblePerson.trim(),
      recordedBy: actor.userId,
      fileAssetIds: input.fileAssetIds ?? [],
      sourceVisitId: input.sourceVisitId ?? null,
      status: "upcoming",
    })
    .returning();

  await recordAudit({
    actor,
    action: "commitment.created",
    entityType: "commitment",
    entityId: commitment.id,
    organizationId,
    after: {
      promisedAmountMinor: commitment.promisedAmountMinor,
      promisedDate: commitment.promisedDate,
    },
    meta,
  });

  return presentCommitment(commitment);
}

export async function cancelCommitment(
  actor: AuthContext,
  organizationId: string,
  commitmentId: string,
  input: CancelInput,
  meta: RequestMeta,
) {
  const commitment = await findCommitment(organizationId, commitmentId);

  if (commitment.status !== "upcoming") {
    throw new AppError(
      "INVALID_STATE",
      `Only 'upcoming' commitments can be cancelled. Current: ${commitment.status}`,
      422,
    );
  }

  const before = { status: commitment.status };
  const [updated] = await db
    .update(commitments)
    .set({ status: "cancelled", cancelReason: input.reason })
    .where(and(eq(commitments.id, commitment.id), eq(commitments.organizationId, organizationId)))
    .returning();

  await recordAudit({
    actor,
    action: "commitment.cancelled",
    entityType: "commitment",
    entityId: commitment.id,
    organizationId,
    before,
    after: { status: "cancelled" },
    reason: input.reason,
    meta,
  });

  return presentCommitment(updated ?? commitment);
}

export async function evaluateCommitment(
  actor: AuthContext,
  organizationId: string,
  commitmentId: string,
  input: EvaluateInput,
  meta: RequestMeta,
) {
  const commitment = await findCommitment(organizationId, commitmentId);

  const before = { status: commitment.status, fulfilledAmountMinor: commitment.fulfilledAmountMinor };
  const [updated] = await db
    .update(commitments)
    .set({
      status: input.status,
      fulfilledAmountMinor: input.fulfilledAmountMinor,
      evaluatedAt: new Date(),
    })
    .where(and(eq(commitments.id, commitment.id), eq(commitments.organizationId, organizationId)))
    .returning();
  if (!updated) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }

  await recordAudit({
    actor,
    action: "commitment.evaluated",
    entityType: "commitment",
    entityId: commitment.id,
    organizationId,
    before,
    after: { status: updated.status, fulfilledAmountMinor: updated.fulfilledAmountMinor },
    meta,
  });

  return presentCommitment(updated);
}

export async function listCommitments(organizationId: string, query: ListQuery) {
  const conditions: SQL[] = [eq(commitments.organizationId, organizationId)];

  if (query.customerId) conditions.push(eq(commitments.customerId, query.customerId));
  if (query.status) conditions.push(eq(commitments.status, query.status));
  if (query.fromDate) conditions.push(gte(commitments.promisedDate, query.fromDate));
  if (query.toDate) conditions.push(lte(commitments.promisedDate, query.toDate));

  const descending = query.sort.startsWith("-");
  const sortColumn = (descending ? query.sort.slice(1) : query.sort) === "promisedDate"
    ? commitments.promisedDate
    : commitments.createdAt;

  const where = and(...conditions);
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db
      .select({
        commitment: commitments,
        customer: { id: customers.id, displayName: customers.displayName, companyName: customers.companyName },
      })
      .from(commitments)
      .leftJoin(customers, eq(customers.id, commitments.customerId))
      .where(where)
      .orderBy(descending ? desc(sortColumn) : asc(sortColumn))
      .limit(query.limit)
      .offset(skip),
    db.$count(commitments, where),
  ]);

  const invoiceMap = await loadInvoicesById(rows.flatMap((row) => row.commitment.invoiceIds));

  return {
    items: rows.map((row) =>
      presentCommitment(row.commitment, { customer: row.customer, invoices: invoiceMap }),
    ),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getCommitment(organizationId: string, commitmentId: string) {
  const [row] = await db
    .select({
      commitment: commitments,
      customer: { id: customers.id, displayName: customers.displayName, companyName: customers.companyName },
    })
    .from(commitments)
    .leftJoin(customers, eq(customers.id, commitments.customerId))
    .where(and(eq(commitments.id, commitmentId), eq(commitments.organizationId, organizationId)))
    .limit(1);

  if (!row) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }

  const invoiceMap = await loadInvoicesById(row.commitment.invoiceIds);
  return presentCommitment(row.commitment, { customer: row.customer, invoices: invoiceMap });
}
