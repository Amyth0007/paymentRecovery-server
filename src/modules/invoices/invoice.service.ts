type QueryFilter = Record<string, any>;
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { CustomerModel } from "../customers/customer.model.js";
import { FileAssetModel } from "../files/file-asset.model.js";
import { InvoiceAcknowledgementModel } from "./invoice-acknowledgement.model.js";
import { InvoiceModel } from "./invoice.model.js";
import type {
  cancelInvoiceSchema,
  createInvoiceDraftSchema,
  invoiceListQuerySchema,
  updateAcknowledgementSchema,
  updateInvoiceDraftSchema,
} from "./invoice.schemas.js";
import { LedgerEntryModel } from "./ledger-entry.model.js";

type CreateDraftInput = z.infer<typeof createInvoiceDraftSchema>;
type UpdateDraftInput = z.infer<typeof updateInvoiceDraftSchema>;
type CancelInput = z.infer<typeof cancelInvoiceSchema>;
type UpdateAckInput = z.infer<typeof updateAcknowledgementSchema>;
type ListQuery = z.infer<typeof invoiceListQuerySchema>;

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function presentInvoice(invoice: any) {
  return {
    id: invoice._id.toString(),
    customerId: invoice.customerId?._id
      ? invoice.customerId._id.toString()
      : invoice.customerId?.toString(),
    customer: invoice.customerId?._id
      ? {
          id: invoice.customerId._id.toString(),
          displayName: invoice.customerId.displayName,
          companyName: invoice.customerId.companyName,
          email: invoice.customerId.email,
          phone: invoice.customerId.phone,
          gstin: invoice.customerId.gstin,
          billingAddress: invoice.customerId.billingAddress,
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
    issuedBy: invoice.issuedBy ? invoice.issuedBy.toString() : null,
    primaryFileAssetId: invoice.primaryFileAssetId
      ? invoice.primaryFileAssetId.toString()
      : null,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
}

export async function createDraft(
  actor: AuthContext,
  organizationId: string,
  input: CreateDraftInput,
  meta: RequestMeta,
) {
  const customer = await CustomerModel.findOne({
    _id: input.customerId,
    organizationId,
    status: "active",
  });
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
    const invoice = await InvoiceModel.create({
      organizationId,
      customerId: customer._id,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: computedDueDate,
      creditDays,
      termSource: input.termSource,
      amountMinor: input.amountMinor,
      currency: "INR",
      outstandingMinor: 0,
      documentStatus: "draft",
      acknowledgementStatus: "not_shared",
      notes: input.notes ?? "",
      primaryFileAssetId: input.primaryFileAssetId ?? null,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });

    await recordAudit({
      actor,
      action: "invoice.draft_created",
      entityType: "invoice",
      entityId: invoice._id.toString(),
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
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId });
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "draft") {
    // If already issued, only notes can be edited
    if (input.notes !== undefined) {
      invoice.notes = input.notes;
      invoice.updatedBy = actor.userId as any;
      await invoice.save();
      return presentInvoice(invoice);
    }
    throw new AppError("INVALID_STATE", "Issued invoices cannot be edited except notes", 422);
  }

  if (input.customerId) {
    const customer = await CustomerModel.findOne({
      _id: input.customerId,
      organizationId,
      status: "active",
    });
    if (!customer) {
      throw new AppError("NOT_FOUND", "Customer not found", 404);
    }
    invoice.customerId = customer._id as any;
  }

  if (input.invoiceNumber) invoice.invoiceNumber = input.invoiceNumber;
  if (input.invoiceDate) invoice.invoiceDate = input.invoiceDate;
  if (input.termSource) invoice.termSource = input.termSource;
  if (input.creditDays !== undefined) invoice.creditDays = input.creditDays;
  if (input.dueDate) invoice.dueDate = input.dueDate;
  if (input.amountMinor) invoice.amountMinor = input.amountMinor;
  if (input.notes !== undefined) invoice.notes = input.notes;
  if (input.primaryFileAssetId !== undefined) {
    invoice.primaryFileAssetId = input.primaryFileAssetId as any;
  }

  if (invoice.termSource === "credit_days" && invoice.creditDays != null) {
    invoice.dueDate = addDaysToDateStr(invoice.invoiceDate, invoice.creditDays);
  }

  invoice.updatedBy = actor.userId as any;

  try {
    await invoice.save();
    return presentInvoice(invoice);
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
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId });
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

  const customer = await CustomerModel.findById(invoice.customerId);
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  const issuedAt = new Date();
  const issuedInvoice = await InvoiceModel.findOneAndUpdate(
    { _id: invoice._id, organizationId, documentStatus: "draft" },
    {
      $set: {
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
      },
    },
    { new: true, runValidators: true },
  );

  if (!issuedInvoice) {
    throw new AppError("INVALID_STATE", "This invoice has already been changed", 422);
  }

  try {
    await LedgerEntryModel.create({
      organizationId,
      customerId: customer._id,
      invoiceId: invoice._id,
      bucket: "principal",
      type: "invoice_issued",
      amountMinor: invoice.amountMinor,
      effectiveDate: invoice.invoiceDate,
      recordedBy: actor.userId,
    });
  } catch (error) {
    // Standalone MongoDB cannot wrap these two writes in a transaction.
    // Restore the draft only if no later operation has changed the invoice.
    await InvoiceModel.updateOne(
      {
        _id: issuedInvoice._id,
        organizationId,
        documentStatus: "issued",
        outstandingMinor: invoice.amountMinor,
        issuedAt,
      },
      {
        $set: {
          documentStatus: "draft",
          outstandingMinor: 0,
          partySnapshot: null,
          issuedAt: null,
          issuedBy: null,
          updatedBy: invoice.updatedBy,
        },
      },
    );
    throw error;
  }

  await recordAudit({
    actor,
    action: "invoice.issued",
    entityType: "invoice",
    entityId: invoice._id.toString(),
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
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId });
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
  const cancelledInvoice = await InvoiceModel.findOneAndUpdate(
    {
      _id: invoice._id,
      organizationId,
      documentStatus: "issued",
      outstandingMinor: invoice.amountMinor,
    },
    {
      $set: {
        documentStatus: "cancelled",
        outstandingMinor: 0,
        cancellation: { reason: input.reason, cancelledBy: actor.userId, cancelledAt },
        updatedBy: actor.userId,
      },
    },
    { new: true, runValidators: true },
  );
  if (!cancelledInvoice) {
    throw new AppError("INVALID_STATE", "This invoice has changed and can no longer be cancelled", 422);
  }

  try {
    await LedgerEntryModel.create({
      organizationId,
      customerId: invoice.customerId,
      invoiceId: invoice._id,
      bucket: "principal",
      type: "invoice_cancelled",
      amountMinor: -invoice.amountMinor,
      effectiveDate: new Date().toISOString().slice(0, 10),
      recordedBy: actor.userId,
    });
  } catch (error) {
    await InvoiceModel.updateOne(
      { _id: invoice._id, organizationId, documentStatus: "cancelled", "cancellation.cancelledAt": cancelledAt },
      {
        $set: {
          documentStatus: "issued",
          outstandingMinor: invoice.amountMinor,
          cancellation: null,
          updatedBy: invoice.updatedBy,
        },
      },
    );
    throw error;
  }

  await recordAudit({
    actor,
    action: "invoice.cancelled",
    entityType: "invoice",
    entityId: invoice._id.toString(),
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
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId });
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }

  if (invoice.documentStatus !== "draft") {
    throw new AppError("INVALID_STATE", "Only draft invoices can be discarded", 422);
  }

  await InvoiceModel.deleteOne({ _id: invoice._id });

  await recordAudit({
    actor,
    action: "invoice.discarded",
    entityType: "invoice",
    entityId: invoice._id.toString(),
    organizationId,
    meta,
  });

  return { success: true };
}

export async function listInvoices(organizationId: string, query: ListQuery) {
  const filter: QueryFilter = { organizationId };

  if (query.customerId) filter.customerId = query.customerId;
  if (query.documentStatus) filter.documentStatus = query.documentStatus;
  if (query.acknowledgementStatus) filter.acknowledgementStatus = query.acknowledgementStatus;

  if (query.dateFrom || query.dateTo) {
    filter.invoiceDate = {
      ...(query.dateFrom ? { $gte: query.dateFrom } : {}),
      ...(query.dateTo ? { $lte: query.dateTo } : {}),
    };
  }
  if (query.paymentStatus === "paid") filter.$expr = { $eq: ["$outstandingMinor", 0] };
  if (query.paymentStatus === "unpaid") filter.$expr = { $eq: ["$outstandingMinor", "$amountMinor"] };
  if (query.paymentStatus === "partial") filter.$expr = { $and: [{ $gt: ["$outstandingMinor", 0] }, { $lt: ["$outstandingMinor", "$amountMinor"] }] };

  if (query.search) {
    const reg = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const customerIds = await CustomerModel.find({ organizationId, displayName: reg }).distinct("_id");
    filter.$or = [{ invoiceNumber: reg }, { "partySnapshot.displayName": reg }, { customerId: { $in: customerIds } }];
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (query.overdueOnly === "true") {
    filter.documentStatus = "issued";
    filter.outstandingMinor = { $gt: 0 };
    filter.dueDate = { $lt: todayStr };
  }
  if (query.dueTodayOnly === "true") {
    filter.documentStatus = "issued";
    filter.dueDate = todayStr;
  }
  if (query.outstandingOnly === "true") {
    filter.documentStatus = "issued";
    filter.outstandingMinor = { $gt: 0 };
  }

  const sortOption: Record<string, 1 | -1> = {};
  if (query.sort.startsWith("-")) {
    sortOption[query.sort.slice(1)] = -1;
  } else {
    sortOption[query.sort] = 1;
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    InvoiceModel.find(filter)
      .populate("customerId", "displayName companyName")
      .sort(sortOption)
      .skip(skip)
      .limit(query.limit),
    InvoiceModel.countDocuments(filter),
  ]);

  return {
    items: items.map(presentInvoice),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getInvoice(organizationId: string, invoiceId: string) {
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId }).populate(
    "customerId",
    "displayName companyName gstin billingAddress phone email",
  );
  if (!invoice) {
    throw new AppError("NOT_FOUND", "Invoice not found", 404);
  }
  return presentInvoice(invoice);
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
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, organizationId });
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
    const evidence = await FileAssetModel.find({
      _id: { $in: input.fileAssetIds },
      organizationId,
      purpose: "acknowledgement_evidence",
    });
    if (evidence.length !== input.fileAssetIds.length || evidence.some((file) => !file.mimeType.startsWith("image/"))) {
      throw new AppError("VALIDATION_ERROR", "Acknowledgement evidence must be an uploaded signed invoice image", 422);
    }
  }

  const before = invoice.acknowledgementStatus;
  invoice.acknowledgementStatus = input.status;
  invoice.updatedBy = actor.userId as any;
  await invoice.save();

  const ackEvent = await InvoiceAcknowledgementModel.create({
    organizationId,
    invoiceId: invoice._id,
    status: input.status,
    eventAt: new Date(),
    responsiblePersonName: input.responsiblePersonName ?? "",
    responsiblePersonDesignation: input.responsiblePersonDesignation ?? "",
    remarks: input.remarks ?? "",
    fileAssetIds: input.fileAssetIds ?? [],
    recordedBy: actor.userId,
  });

  await recordAudit({
    actor,
    action: "invoice.acknowledgement_updated",
    entityType: "invoice",
    entityId: invoice._id.toString(),
    organizationId,
    before: { acknowledgementStatus: before },
    after: { acknowledgementStatus: input.status },
    meta,
  });

  return {
    invoice: presentInvoice(invoice),
    acknowledgement: {
      id: ackEvent._id.toString(),
      status: ackEvent.status,
      eventAt: ackEvent.eventAt,
      responsiblePersonName: ackEvent.responsiblePersonName,
      responsiblePersonDesignation: ackEvent.responsiblePersonDesignation,
      remarks: ackEvent.remarks,
    },
  };
}

export async function getAcknowledgementHistory(organizationId: string, invoiceId: string) {
  const history = await InvoiceAcknowledgementModel.find({
    organizationId,
    invoiceId,
  })
    .populate("recordedBy", "name email")
    .populate("fileAssetIds", "originalFilename mimeType sizeBytes")
    .sort({ createdAt: -1 });

  return history.map((item: any) => ({
    id: item._id.toString(),
    status: item.status,
    eventAt: item.eventAt,
    responsiblePersonName: item.responsiblePersonName,
    responsiblePersonDesignation: item.responsiblePersonDesignation,
    remarks: item.remarks,
    files: (item.fileAssetIds ?? []).map((file: any) => ({
      id: file._id?.toString?.() ?? file.toString(),
      originalFilename: file.originalFilename ?? "Acknowledgement evidence",
    })),
    recordedBy: item.recordedBy
      ? { id: item.recordedBy._id.toString(), name: item.recordedBy.name }
      : null,
    createdAt: item.createdAt,
  }));
}
