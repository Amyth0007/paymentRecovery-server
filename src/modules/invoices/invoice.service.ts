import { and, asc, desc, eq, gt, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { escapeLike, isDuplicateKey } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import {
  customers,
  fileAssets,
  invoiceAcknowledgements,
  invoices,
  ledgerEntries,
  users,
} from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  cancelInvoiceSchema,
  createInvoiceDraftSchema,
  invoiceListQuerySchema,
  updateAcknowledgementSchema,
  updateInvoiceDraftSchema,
} from "./invoice.schemas.js";

type CreateDraftInput = z.infer<typeof createInvoiceDraftSchema>;
type UpdateDraftInput = z.infer<typeof updateInvoiceDraftSchema>;
type CancelInput = z.infer<typeof cancelInvoiceSchema>;
type UpdateAckInput = z.infer<typeof updateAcknowledgementSchema>;
type ListQuery = z.infer<typeof invoiceListQuerySchema>;
type InvoiceRow = typeof invoices.$inferSelect;

/** Populated customer reference (only the selected fields, like Mongoose `.populate(path, fields)`). */
type PopulatedCustomer = {
  id: string;
  displayName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  gstin?: string | null;
  billingAddress?: unknown;
};

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the invoice DTO. Pass `customer` to reproduce the old populated `customerId` output
 * (`customer: { id, ...selected fields }`); without it `customer` is omitted.
 */
export function presentInvoice(invoice: InvoiceRow, customer?: PopulatedCustomer | null) {
  return {
    id: invoice.id,
    customerId: invoice.customerId,
    customer: customer
      ? {
          id: customer.id,
          displayName: customer.displayName,
          companyName: customer.companyName,
          email: customer.email,
          phone: customer.phone,
          gstin: customer.gstin,
          billingAddress: customer.billingAddress,
        }
      : undefined,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    creditDays: invoice.creditDays,
    termSource: invoice.termSource,
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    outstandingMinor: invoice.outstandingMinor,
    documentStatus: invoice.documentStatus,
    acknowledgementStatus: invoice.acknowledgementStatus,
    partySnapshot: invoice.partySnapshot ?? null,
    notes: invoice.notes ?? "",
    cancellation: invoice.cancellation ?? null,
    issuedAt: invoice.issuedAt ?? null,
    issuedBy: invoice.issuedBy ?? null,
    primaryFileAssetId: invoice.primaryFileAssetId ?? null,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
}

async function findInvoice(organizationId: string, invoiceId: string) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
    .limit(1);
  return invoice ?? null;
}

async function findActiveCustomer(organizationId: string, customerId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, customerId),
        eq(customers.organizationId, organizationId),
        eq(customers.status, "active"),
      ),
    )
    .limit(1);
  return customer ?? null;
}

export async function createDraft(
  actor: AuthContext,
  organizationId: string,
  input: CreateDraftInput,
  meta: RequestMeta,
) {
  const customer = await findActiveCustomer(organizationId, input.customerId);
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found or not active", 404);
  }

  let computedDueDate = input.dueDate;
  let creditDays = input.creditDays ?? null;

  if (input.termSource === "credit_days") {
    creditDays = input.creditDays ?? customer.defaultCreditDays;
    computedDueDate = addDaysToDateStr(input.invoiceDate, creditDays);
  }

  try {
    const [invoice] = await db
      .insert(invoices)
      .values({
        organizationId,
        customerId: customer.id,
        invoiceNumber: input.invoiceNumber.trim(),
        invoiceDate: input.invoiceDate,
        dueDate: computedDueDate!,
        creditDays,
        termSource: input.termSource,
        amountMinor: input.amountMinor,
        currency: "INR",
        outstandingMinor: 0,
        documentStatus: "draft",
        acknowledgementStatus: "not_shared",
        notes: (input.notes ?? "").trim(),
        primaryFileAssetId: input.primaryFileAssetId ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();

    await recordAudit({
      actor,
      action: "invoice.draft_created",
      entityType: "invoice",
      entityId: invoice.id,
      organizationId,
      after: { invoiceNumber: invoice.invoiceNumber, amountMinor: invoice.amountMinor },
      meta,
    });

    return presentInvoice(invoice);
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new AppError(
        "CONFLICT",
        `Invoice number '${input.invoiceNumber}' already exists in this organization`,
        409,
      );
    }
    throw err;
  }
}

export async function updateDraft(
  actor: AuthContext,
  organizationId: string,
  invoiceId: string,
  input: UpdateDraftInput,
  _meta?: RequestMeta,
) {
  const invoice = await findInvoice(organizationId, invoiceId);
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "draft") {
    // If already issued, only notes can be edited
    if (input.notes !== undefined) {
      const [updated] = await db
        .update(invoices)
        .set({ notes: input.notes.trim(), updatedBy: actor.userId })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.organizationId, organizationId)))
        .returning();
      return presentInvoice(updated ?? invoice);
    }
    throw new AppError("INVALID_STATE", "Issued invoices cannot be edited except notes", 422);
  }

  const next = { ...invoice };

  if (input.customerId) {
    const customer = await findActiveCustomer(organizationId, input.customerId);
    if (!customer) {
      throw new AppError("NOT_FOUND", "Customer not found", 404);
    }
    next.customerId = customer.id;
  }

  if (input.invoiceNumber) next.invoiceNumber = input.invoiceNumber.trim();
  if (input.invoiceDate) next.invoiceDate = input.invoiceDate;
  if (input.termSource) next.termSource = input.termSource;
  if (input.creditDays !== undefined) next.creditDays = input.creditDays;
  if (input.dueDate) next.dueDate = input.dueDate;
  if (input.amountMinor) next.amountMinor = input.amountMinor;
  if (input.notes !== undefined) next.notes = input.notes.trim();
  if (input.primaryFileAssetId !== undefined) {
    next.primaryFileAssetId = input.primaryFileAssetId;
  }

  if (next.termSource === "credit_days" && next.creditDays != null) {
    next.dueDate = addDaysToDateStr(next.invoiceDate, next.creditDays);
  }

  try {
    const [updated] = await db
      .update(invoices)
      .set({
        customerId: next.customerId,
        invoiceNumber: next.invoiceNumber,
        invoiceDate: next.invoiceDate,
        termSource: next.termSource,
        creditDays: next.creditDays,
        dueDate: next.dueDate,
        amountMinor: next.amountMinor,
        notes: next.notes,
        primaryFileAssetId: next.primaryFileAssetId,
        updatedBy: actor.userId,
      })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.organizationId, organizationId)))
      .returning();
    if (!updated) {
      throw new AppError("NOT_FOUND", "Invoice not found", 404);
    }
    return presentInvoice(updated);
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new AppError("CONFLICT", "Invoice number already exists", 409);
    }
    throw err;
  }
}

export async function issueInvoice(
  actor: AuthContext,
  organizationId: string,
  invoiceId: string,
  meta: RequestMeta,
) {
  const invoice = await findInvoice(organizationId, invoiceId);
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "draft") {
    throw new AppError(
      "INVALID_STATE",
      `Only draft invoices can be issued. Current status: ${invoice.documentStatus}`,
      422,
    );
  }

  const [customer] = await db.select().from(customers).where(eq(customers.id, invoice.customerId)).limit(1);
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  const issuedAt = new Date();
  const issuedInvoice = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(invoices)
      .set({
        partySnapshot: {
          displayName: customer.displayName,
          companyName: customer.companyName,
          gstin: customer.gstin,
          billingAddress: customer.billingAddress,
        },
        documentStatus: "issued",
        outstandingMinor: invoice.amountMinor,
        issuedAt,
        issuedBy: actor.userId,
        updatedBy: actor.userId,
      })
      .where(
        and(
          eq(invoices.id, invoice.id),
          eq(invoices.organizationId, organizationId),
          eq(invoices.documentStatus, "draft"),
        ),
      )
      .returning();

    if (!updated) {
      throw new AppError("INVALID_STATE", "This invoice has already been changed", 422);
    }

    await tx.insert(ledgerEntries).values({
      organizationId,
      customerId: customer.id,
      invoiceId: invoice.id,
      bucket: "principal",
      type: "invoice_issued",
      amountMinor: invoice.amountMinor,
      effectiveDate: invoice.invoiceDate,
      recordedBy: actor.userId,
    });

    return updated;
  });

  await recordAudit({
    actor,
    action: "invoice.issued",
    entityType: "invoice",
    entityId: invoice.id,
    organizationId,
    after: { invoiceNumber: invoice.invoiceNumber, amountMinor: invoice.amountMinor },
    meta,
  });

  return presentInvoice(issuedInvoice);
}

export async function cancelInvoice(
  actor: AuthContext,
  organizationId: string,
  invoiceId: string,
  input: CancelInput,
  meta: RequestMeta,
) {
  const invoice = await findInvoice(organizationId, invoiceId);
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "issued") {
    throw new AppError(
      "INVALID_STATE",
      `Only issued invoices can be cancelled. Current status: ${invoice.documentStatus}`,
      422,
    );
  }

  if (invoice.outstandingMinor !== invoice.amountMinor) {
    throw new AppError(
      "INVALID_STATE",
      "Cannot cancel an invoice with payments applied. Reverse payments first.",
      422,
    );
  }

  const cancelledAt = new Date();
  const cancelledInvoice = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(invoices)
      .set({
        documentStatus: "cancelled",
        outstandingMinor: 0,
        cancellation: { reason: input.reason, cancelledBy: actor.userId, cancelledAt: cancelledAt.toISOString() },
        updatedBy: actor.userId,
      })
      .where(
        and(
          eq(invoices.id, invoice.id),
          eq(invoices.organizationId, organizationId),
          eq(invoices.documentStatus, "issued"),
          eq(invoices.outstandingMinor, invoice.amountMinor),
        ),
      )
      .returning();
    if (!updated) {
      throw new AppError("INVALID_STATE", "This invoice has changed and can no longer be cancelled", 422);
    }

    await tx.insert(ledgerEntries).values({
      organizationId,
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      bucket: "principal",
      type: "invoice_cancelled",
      amountMinor: -invoice.amountMinor,
      effectiveDate: new Date().toISOString().slice(0, 10),
      recordedBy: actor.userId,
    });

    return updated;
  });

  await recordAudit({
    actor,
    action: "invoice.cancelled",
    entityType: "invoice",
    entityId: invoice.id,
    organizationId,
    reason: input.reason,
    after: { status: "cancelled" },
    meta,
  });

  return presentInvoice(cancelledInvoice);
}

export async function discardDraft(
  actor: AuthContext,
  organizationId: string,
  invoiceId: string,
  meta: RequestMeta,
) {
  const invoice = await findInvoice(organizationId, invoiceId);
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "draft") {
    throw new AppError("INVALID_STATE", "Only draft invoices can be discarded", 422);
  }

  await db.delete(invoices).where(eq(invoices.id, invoice.id));

  await recordAudit({
    actor,
    action: "invoice.discarded",
    entityType: "invoice",
    entityId: invoice.id,
    organizationId,
    meta,
  });

  return { success: true };
}

const invoiceSortColumns = {
  dueDate: invoices.dueDate,
  invoiceDate: invoices.invoiceDate,
  amountMinor: invoices.amountMinor,
  outstandingMinor: invoices.outstandingMinor,
  createdAt: invoices.createdAt,
} as const;

export async function listInvoices(organizationId: string, query: ListQuery) {
  const conditions: SQL[] = [eq(invoices.organizationId, organizationId)];

  let documentStatus: InvoiceRow["documentStatus"] | undefined = query.documentStatus;
  let dueDateCondition: SQL | undefined;
  let outstandingPositive = false;

  if (query.customerId) conditions.push(eq(invoices.customerId, query.customerId));
  if (query.acknowledgementStatus) {
    conditions.push(eq(invoices.acknowledgementStatus, query.acknowledgementStatus));
  }

  if (query.dateFrom) conditions.push(gte(invoices.invoiceDate, query.dateFrom));
  if (query.dateTo) conditions.push(lte(invoices.invoiceDate, query.dateTo));

  if (query.paymentStatus === "paid") conditions.push(eq(invoices.outstandingMinor, 0));
  if (query.paymentStatus === "unpaid") conditions.push(sql`${invoices.outstandingMinor} = ${invoices.amountMinor}`);
  if (query.paymentStatus === "partial") {
    conditions.push(gt(invoices.outstandingMinor, 0), sql`${invoices.outstandingMinor} < ${invoices.amountMinor}`);
  }

  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    const matchingCustomers = db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.organizationId, organizationId), ilike(customers.displayName, pattern)));
    conditions.push(
      or(
        ilike(invoices.invoiceNumber, pattern),
        sql`(${invoices.partySnapshot} ->> 'displayName') ilike ${pattern}`,
        inArray(invoices.customerId, matchingCustomers),
      )!,
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (query.overdueOnly === "true") {
    documentStatus = "issued";
    outstandingPositive = true;
    dueDateCondition = lt(invoices.dueDate, todayStr);
  }
  if (query.dueTodayOnly === "true") {
    documentStatus = "issued";
    dueDateCondition = eq(invoices.dueDate, todayStr);
  }
  if (query.outstandingOnly === "true") {
    documentStatus = "issued";
    outstandingPositive = true;
  }

  if (documentStatus) conditions.push(eq(invoices.documentStatus, documentStatus));
  if (outstandingPositive) conditions.push(gt(invoices.outstandingMinor, 0));
  if (dueDateCondition) conditions.push(dueDateCondition);

  const descending = query.sort.startsWith("-");
  const sortColumn = invoiceSortColumns[(descending ? query.sort.slice(1) : query.sort) as keyof typeof invoiceSortColumns];

  const where = and(...conditions);
  const skip = (query.page - 1) * query.limit;
  const [rows, total] = await Promise.all([
    db
      .select({
        invoice: invoices,
        customer: { id: customers.id, displayName: customers.displayName, companyName: customers.companyName },
      })
      .from(invoices)
      .leftJoin(customers, eq(customers.id, invoices.customerId))
      .where(where)
      .orderBy(descending ? desc(sortColumn) : asc(sortColumn))
      .limit(query.limit)
      .offset(skip),
    db.$count(invoices, where),
  ]);

  return {
    items: rows.map((row) => presentInvoice(row.invoice, row.customer)),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getInvoice(organizationId: string, invoiceId: string) {
  const [row] = await db
    .select({
      invoice: invoices,
      customer: {
        id: customers.id,
        displayName: customers.displayName,
        companyName: customers.companyName,
        gstin: customers.gstin,
        billingAddress: customers.billingAddress,
        phone: customers.phone,
        email: customers.email,
      },
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }
  return presentInvoice(row.invoice, row.customer);
}

const validAckTransitions: Record<string, string[]> = {
  not_shared: ["shared", "disputed"],
  shared: ["acknowledged", "rejected", "disputed"],
  rejected: ["shared", "disputed"],
  acknowledged: ["disputed"],
  disputed: ["acknowledged", "shared"],
};

export async function updateAcknowledgement(
  actor: AuthContext,
  organizationId: string,
  invoiceId: string,
  input: UpdateAckInput,
  meta: RequestMeta,
) {
  const invoice = await findInvoice(organizationId, invoiceId);
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "issued") {
    throw new AppError("INVALID_STATE", "Acknowledgement applies only to issued invoices", 422);
  }

  const allowed = validAckTransitions[invoice.acknowledgementStatus] ?? [];
  if (!allowed.includes(input.status)) {
    throw new AppError(
      "INVALID_STATE",
      `Cannot transition acknowledgement from '${invoice.acknowledgementStatus}' to '${input.status}'`,
      422,
    );
  }

  if (input.status === "acknowledged") {
    if (!input.fileAssetIds?.length) {
      throw new AppError("VALIDATION_ERROR", "Upload the customer-signed invoice image", 422);
    }
    const evidence = await db
      .select({ id: fileAssets.id, mimeType: fileAssets.mimeType })
      .from(fileAssets)
      .where(
        and(
          inArray(fileAssets.id, input.fileAssetIds),
          eq(fileAssets.organizationId, organizationId),
          eq(fileAssets.purpose, "acknowledgement_evidence"),
        ),
      );
    if (evidence.length !== input.fileAssetIds.length || evidence.some((file) => !file.mimeType.startsWith("image/"))) {
      throw new AppError("VALIDATION_ERROR", "Acknowledgement evidence must be an uploaded signed invoice image", 422);
    }
  }

  const before = invoice.acknowledgementStatus;

  const { updatedInvoice, ackEvent } = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(invoices)
      .set({ acknowledgementStatus: input.status, updatedBy: actor.userId })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.organizationId, organizationId)))
      .returning();

    const [event] = await tx
      .insert(invoiceAcknowledgements)
      .values({
        organizationId,
        invoiceId: invoice.id,
        status: input.status,
        eventAt: new Date(),
        responsiblePersonName: (input.responsiblePersonName ?? "").trim(),
        responsiblePersonDesignation: (input.responsiblePersonDesignation ?? "").trim(),
        remarks: (input.remarks ?? "").trim(),
        fileAssetIds: input.fileAssetIds ?? [],
        recordedBy: actor.userId,
      })
      .returning();

    return { updatedInvoice: updated ?? invoice, ackEvent: event };
  });

  await recordAudit({
    actor,
    action: "invoice.acknowledgement_updated",
    entityType: "invoice",
    entityId: invoice.id,
    organizationId,
    before: { acknowledgementStatus: before },
    after: { acknowledgementStatus: input.status },
    meta,
  });

  return {
    invoice: presentInvoice(updatedInvoice),
    acknowledgement: {
      id: ackEvent.id,
      status: ackEvent.status,
      eventAt: ackEvent.eventAt,
      responsiblePersonName: ackEvent.responsiblePersonName,
      responsiblePersonDesignation: ackEvent.responsiblePersonDesignation,
      remarks: ackEvent.remarks,
    },
  };
}

export async function getAcknowledgementHistory(organizationId: string, invoiceId: string) {
  const history = await db
    .select({
      ack: invoiceAcknowledgements,
      recordedBy: { id: users.id, name: users.name },
    })
    .from(invoiceAcknowledgements)
    .leftJoin(users, eq(users.id, invoiceAcknowledgements.recordedBy))
    .where(
      and(
        eq(invoiceAcknowledgements.organizationId, organizationId),
        eq(invoiceAcknowledgements.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoiceAcknowledgements.createdAt));

  // Populate file assets (missing files are dropped, as Mongoose populate did).
  const fileIds = [...new Set(history.flatMap((item) => item.ack.fileAssetIds))];
  const files = fileIds.length
    ? await db
        .select({ id: fileAssets.id, originalFilename: fileAssets.originalFilename })
        .from(fileAssets)
        .where(inArray(fileAssets.id, fileIds))
    : [];
  const filesById = new Map(files.map((file) => [file.id, file]));

  return history.map(({ ack: item, recordedBy }) => ({
    id: item.id,
    status: item.status,
    eventAt: item.eventAt,
    responsiblePersonName: item.responsiblePersonName,
    responsiblePersonDesignation: item.responsiblePersonDesignation,
    remarks: item.remarks,
    files: item.fileAssetIds
      .map((fileId) => filesById.get(fileId))
      .filter((file): file is { id: string; originalFilename: string } => Boolean(file))
      .map((file) => ({
        id: file.id,
        originalFilename: file.originalFilename ?? "Acknowledgement evidence",
      })),
    recordedBy: recordedBy ? { id: recordedBy.id, name: recordedBy.name } : null,
    createdAt: item.createdAt,
  }));
}
