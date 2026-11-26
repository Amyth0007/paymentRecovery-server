import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/db.js";
import { db, type DbOrTx } from "../../database/connection.js";
import {
  customers,
  invoices,
  ledgerEntries,
  paymentAllocations,
  payments,
  users,
} from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  createPaymentSchema,
  paymentListQuerySchema,
  reversePaymentSchema,
} from "./payment.schemas.js";

type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
type ReverseInput = z.infer<typeof reversePaymentSchema>;
type ListQuery = z.infer<typeof paymentListQuerySchema>;
type PaymentRow = typeof payments.$inferSelect;

/** A payment allocation as it used to be embedded on the payment document. */
export type PaymentAllocationView = {
  invoiceId: string;
  bucket: string;
  amountMinor: number;
  /** Present only when the invoice reference was populated. */
  invoiceNumber?: string;
};

type PopulatedCustomer = { id: string; displayName: string; companyName: string };

/**
 * Builds the payment DTO. `allocations` come from the `paymentAllocations` child table (ordered by
 * position). Pass `customer` to reproduce the old populated `customerId` output.
 */
export function presentPayment(
  payment: PaymentRow,
  allocations: PaymentAllocationView[],
  customer?: PopulatedCustomer | null,
) {
  return {
    id: payment.id,
    customerId: payment.customerId,
    customer: customer
      ? {
          id: customer.id,
          displayName: customer.displayName,
          companyName: customer.companyName,
        }
      : undefined,
    kind: payment.kind,
    reversesPaymentId: payment.reversesPaymentId ?? null,
    paymentReference: payment.paymentReference,
    paymentDate: payment.paymentDate,
    mode: payment.mode,
    transactionReference: payment.transactionReference ?? "",
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    allocations: allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoiceNumber,
      bucket: a.bucket,
      amountMinor: a.amountMinor,
    })),
    fileAssetIds: payment.fileAssetIds ?? [],
    remarks: payment.remarks ?? "",
    status: payment.status,
    idempotencyKey: payment.idempotencyKey,
    reversedAt: payment.reversedAt ?? null,
    createdAt: payment.createdAt,
  };
}

/** Loads allocations for the given payments, grouped by payment id and ordered by position. */
async function loadAllocations(
  paymentIds: string[],
  options: { withInvoiceNumber?: boolean } = {},
  executor: DbOrTx = db,
): Promise<Map<string, PaymentAllocationView[]>> {
  const grouped = new Map<string, PaymentAllocationView[]>();
  if (!paymentIds.length) return grouped;

  const rows = await executor
    .select({
      paymentId: paymentAllocations.paymentId,
      invoiceId: paymentAllocations.invoiceId,
      bucket: paymentAllocations.bucket,
      amountMinor: paymentAllocations.amountMinor,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(paymentAllocations)
    .leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(inArray(paymentAllocations.paymentId, paymentIds))
    .orderBy(asc(paymentAllocations.paymentId), asc(paymentAllocations.position));

  for (const row of rows) {
    const allocation: PaymentAllocationView = {
      invoiceId: row.invoiceId,
      bucket: row.bucket,
      amountMinor: row.amountMinor,
    };
    if (options.withInvoiceNumber && row.invoiceNumber != null) allocation.invoiceNumber = row.invoiceNumber;
    const list = grouped.get(row.paymentId) ?? [];
    list.push(allocation);
    grouped.set(row.paymentId, list);
  }
  return grouped;
}

async function presentUnpopulatedPayment(payment: PaymentRow) {
  const allocations = await loadAllocations([payment.id]);
  return presentPayment(payment, allocations.get(payment.id) ?? []);
}

async function findPaymentByIdempotencyKey(organizationId: string, idempotencyKey: string) {
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.organizationId, organizationId), eq(payments.idempotencyKey, idempotencyKey)))
    .limit(1);
  return payment ?? null;
}

export async function createPayment(
  actor: AuthContext,
  organizationId: string,
  input: CreatePaymentInput,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  // 1. Check idempotency key
  const existing = await findPaymentByIdempotencyKey(organizationId, idempotencyKey);
  if (existing) {
    if (existing.amountMinor === input.amountMinor && existing.customerId === input.customerId) {
      return presentUnpopulatedPayment(existing);
    }
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "A payment was already submitted with this idempotency key but different payload",
      409,
    );
  }

  // 2. Validate customer
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

  // 3. Verify total sum matches sum of allocations
  const allocSum = input.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  if (allocSum !== input.amountMinor) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Sum of allocations (₹${(allocSum / 100).toFixed(2)}) must equal payment amount (₹${(input.amountMinor / 100).toFixed(2)})`,
      422,
    );
  }

  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    throw new AppError("VALIDATION_ERROR", "Allocate each invoice only once", 422);
  }

  const invoiceRows = await db
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, outstandingMinor: invoices.outstandingMinor })
    .from(invoices)
    .where(
      and(
        inArray(invoices.id, invoiceIds),
        eq(invoices.organizationId, organizationId),
        eq(invoices.customerId, customer.id),
        eq(invoices.documentStatus, "issued"),
      ),
    );

  if (invoiceRows.length !== invoiceIds.length) {
    throw new AppError(
      "INVALID_STATE",
      "One or more invoices do not exist, do not belong to this customer, or are not issued",
      422,
    );
  }

  const invoiceMap = new Map(invoiceRows.map((inv) => [inv.id, inv]));
  for (const alloc of input.allocations) {
    const inv = invoiceMap.get(alloc.invoiceId)!;
    if (alloc.amountMinor > inv.outstandingMinor) {
      throw new AppError(
        "INVALID_STATE",
        `Allocation of ₹${(alloc.amountMinor / 100).toFixed(2)} exceeds invoice ${inv.invoiceNumber} outstanding balance of ₹${(inv.outstandingMinor / 100).toFixed(2)}`,
        422,
      );
    }
  }

  const allocationViews: PaymentAllocationView[] = input.allocations.map((a) => ({
    invoiceId: a.invoiceId,
    bucket: "principal",
    amountMinor: a.amountMinor,
  }));

  let createdPayment: PaymentRow;
  try {
    createdPayment = await db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(payments)
        .values({
          organizationId,
          customerId: customer.id,
          kind: "collection",
          reversesPaymentId: null,
          paymentReference: input.paymentReference.trim(),
          paymentDate: input.paymentDate,
          mode: input.mode,
          transactionReference: (input.transactionReference ?? "").trim(),
          amountMinor: input.amountMinor,
          currency: "INR",
          fileAssetIds: input.fileAssetIds ?? [],
          remarks: (input.remarks ?? "").trim(),
          status: "posted",
          idempotencyKey,
          reversedAt: null,
          recordedBy: actor.userId,
        })
        .returning();

      await tx.insert(paymentAllocations).values(
        input.allocations.map((a, position) => ({
          paymentId: payment.id,
          organizationId,
          position,
          invoiceId: a.invoiceId,
          bucket: "principal" as const,
          amountMinor: a.amountMinor,
        })),
      );

      for (const alloc of input.allocations) {
        const inv = invoiceMap.get(alloc.invoiceId)!;
        const updated = await tx
          .update(invoices)
          .set({
            outstandingMinor: sql`${invoices.outstandingMinor} - ${alloc.amountMinor}`,
            updatedBy: actor.userId,
          })
          .where(
            and(
              eq(invoices.id, inv.id),
              eq(invoices.organizationId, organizationId),
              eq(invoices.documentStatus, "issued"),
              gte(invoices.outstandingMinor, alloc.amountMinor),
            ),
          )
          .returning({ id: invoices.id });
        if (updated.length !== 1) {
          throw new AppError("INVALID_STATE", `Invoice ${inv.invoiceNumber} no longer has enough outstanding balance`, 422);
        }
      }

      await tx.insert(ledgerEntries).values(
        input.allocations.map((alloc) => ({
          organizationId,
          customerId: customer.id,
          invoiceId: alloc.invoiceId,
          bucket: "principal" as const,
          type: "payment_allocation" as const,
          amountMinor: -alloc.amountMinor,
          paymentId: payment.id,
          effectiveDate: input.paymentDate,
          recordedBy: actor.userId,
        })),
      );

      return payment;
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const duplicate = await findPaymentByIdempotencyKey(organizationId, idempotencyKey);
      if (duplicate && duplicate.amountMinor === input.amountMinor && duplicate.customerId === input.customerId) {
        return presentUnpopulatedPayment(duplicate);
      }
      throw new AppError("IDEMPOTENCY_CONFLICT", "This payment request was already submitted", 409);
    }
    throw error;
  }

  await recordAudit({
    actor,
    action: "payment.recorded",
    entityType: "payment",
    entityId: createdPayment.id,
    organizationId,
    after: {
      paymentReference: input.paymentReference,
      amountMinor: input.amountMinor,
      mode: input.mode,
    },
    meta,
  });

  return presentPayment(createdPayment, allocationViews);
}

export async function reversePayment(
  actor: AuthContext,
  organizationId: string,
  paymentId: string,
  input: ReverseInput,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  const replayPriorReversal = async () => {
    const priorReversal = await findPaymentByIdempotencyKey(organizationId, idempotencyKey);
    if (!priorReversal) return null;
    if (priorReversal.reversesPaymentId === paymentId) {
      return presentUnpopulatedPayment(priorReversal);
    }
    throw new AppError("IDEMPOTENCY_CONFLICT", "This reversal request key was already used", 409);
  };

  const prior = await replayPriorReversal();
  if (prior) return prior;

  const [original] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId)))
    .limit(1);
  if (!original) {
    throw new AppError("NOT_FOUND", "Payment not found", 404);
  }

  if (original.kind !== "collection") {
    throw new AppError("INVALID_STATE", "Only collection payments can be reversed", 422);
  }

  if (original.reversedAt) {
    throw new AppError("CONFLICT", "This payment has already been reversed", 409);
  }

  const originalAllocations = (await loadAllocations([original.id])).get(original.id) ?? [];
  const reversedAt = new Date();
  const paymentDate = new Date().toISOString().slice(0, 10);

  let reversalPayment: PaymentRow;
  try {
    reversalPayment = await db.transaction(async (tx) => {
      const [claimedOriginal] = await tx
        .update(payments)
        .set({ reversedAt })
        .where(
          and(
            eq(payments.id, original.id),
            eq(payments.organizationId, organizationId),
            eq(payments.kind, "collection"),
            isNull(payments.reversedAt),
          ),
        )
        .returning({ id: payments.id });
      if (!claimedOriginal) {
        throw new AppError("CONFLICT", "This payment has already been reversed", 409);
      }

      const [reversal] = await tx
        .insert(payments)
        .values({
          organizationId,
          customerId: original.customerId,
          kind: "reversal",
          reversesPaymentId: original.id,
          paymentReference: `REV-${original.paymentReference}`.trim(),
          paymentDate,
          mode: original.mode,
          transactionReference: original.transactionReference,
          amountMinor: original.amountMinor,
          currency: original.currency,
          fileAssetIds: [],
          remarks: `Reversal: ${input.reason}`.trim(),
          status: "posted",
          idempotencyKey,
          reversedAt: null,
          recordedBy: actor.userId,
        })
        .returning();

      if (originalAllocations.length) {
        await tx.insert(paymentAllocations).values(
          originalAllocations.map((alloc, position) => ({
            paymentId: reversal.id,
            organizationId,
            position,
            invoiceId: alloc.invoiceId,
            bucket: "principal" as const,
            amountMinor: alloc.amountMinor,
          })),
        );
      }

      for (const alloc of originalAllocations) {
        const updated = await tx
          .update(invoices)
          .set({ outstandingMinor: sql`${invoices.outstandingMinor} + ${alloc.amountMinor}` })
          .where(and(eq(invoices.id, alloc.invoiceId), eq(invoices.organizationId, organizationId)))
          .returning({ id: invoices.id });
        if (updated.length !== 1) {
          throw new AppError("NOT_FOUND", "An invoice from this payment no longer exists", 404);
        }
      }

      if (originalAllocations.length) {
        await tx.insert(ledgerEntries).values(
          originalAllocations.map((alloc) => ({
            organizationId,
            customerId: original.customerId,
            invoiceId: alloc.invoiceId,
            bucket: "principal" as const,
            type: "payment_reversal" as const,
            amountMinor: alloc.amountMinor,
            paymentId: reversal.id,
            effectiveDate: paymentDate,
            recordedBy: actor.userId,
          })),
        );
      }

      return reversal;
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      // A concurrent request with the same idempotency key won the race.
      const replay = await replayPriorReversal();
      if (replay) return replay;
    }
    throw error;
  }

  await recordAudit({
    actor,
    action: "payment.reversed",
    entityType: "payment",
    entityId: original.id,
    organizationId,
    reason: input.reason,
    after: { reversalPaymentId: reversalPayment.id },
    meta,
  });

  return presentPayment(
    reversalPayment,
    originalAllocations.map(({ invoiceId, bucket, amountMinor }) => ({ invoiceId, bucket, amountMinor })),
  );
}

export async function listPayments(organizationId: string, query: ListQuery) {
  const conditions: SQL[] = [eq(payments.organizationId, organizationId)];

  if (query.customerId) conditions.push(eq(payments.customerId, query.customerId));
  if (query.kind) conditions.push(eq(payments.kind, query.kind));
  if (query.invoiceId) {
    conditions.push(
      inArray(
        payments.id,
        db
          .select({ paymentId: paymentAllocations.paymentId })
          .from(paymentAllocations)
          .where(
            and(
              eq(paymentAllocations.organizationId, organizationId),
              eq(paymentAllocations.invoiceId, query.invoiceId),
            ),
          ),
      ),
    );
  }
  if (query.fromDate) conditions.push(gte(payments.paymentDate, query.fromDate));
  if (query.toDate) conditions.push(lte(payments.paymentDate, query.toDate));

  const descending = query.sort.startsWith("-");
  const sortColumn = (descending ? query.sort.slice(1) : query.sort) === "paymentDate"
    ? payments.paymentDate
    : payments.createdAt;

  const where = and(...conditions);
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db
      .select({
        payment: payments,
        customer: { id: customers.id, displayName: customers.displayName, companyName: customers.companyName },
      })
      .from(payments)
      .leftJoin(customers, eq(customers.id, payments.customerId))
      .where(where)
      .orderBy(descending ? desc(sortColumn) : asc(sortColumn))
      .limit(query.limit)
      .offset(skip),
    db.$count(payments, where),
  ]);

  const allocations = await loadAllocations(rows.map((row) => row.payment.id), { withInvoiceNumber: true });

  return {
    items: rows.map((row) => presentPayment(row.payment, allocations.get(row.payment.id) ?? [], row.customer)),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getPayment(organizationId: string, paymentId: string) {
  const [row] = await db
    .select({
      payment: payments,
      customer: { id: customers.id, displayName: customers.displayName, companyName: customers.companyName },
    })
    .from(payments)
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .where(and(eq(payments.id, paymentId), eq(payments.organizationId, organizationId)))
    .limit(1);

  if (!row) {
    throw new AppError("NOT_FOUND", "Payment not found", 404);
  }
  const allocations = await loadAllocations([row.payment.id], { withInvoiceNumber: true });
  return presentPayment(row.payment, allocations.get(row.payment.id) ?? [], row.customer);
}

export async function getInvoiceLedger(organizationId: string, invoiceId: string) {
  const entries = await db
    .select({
      entry: ledgerEntries,
      payment: { id: payments.id, paymentReference: payments.paymentReference },
      recordedBy: { id: users.id, name: users.name },
    })
    .from(ledgerEntries)
    .leftJoin(payments, eq(payments.id, ledgerEntries.paymentId))
    .leftJoin(users, eq(users.id, ledgerEntries.recordedBy))
    .where(and(eq(ledgerEntries.organizationId, organizationId), eq(ledgerEntries.invoiceId, invoiceId)))
    .orderBy(asc(ledgerEntries.createdAt));

  return entries.map(({ entry: e, payment, recordedBy }) => ({
    id: e.id,
    bucket: e.bucket,
    type: e.type,
    amountMinor: e.amountMinor,
    effectiveDate: e.effectiveDate,
    payment: payment ? { id: payment.id, reference: payment.paymentReference } : null,
    recordedBy: recordedBy ? { id: recordedBy.id, name: recordedBy.name } : null,
    createdAt: e.createdAt,
  }));
}
