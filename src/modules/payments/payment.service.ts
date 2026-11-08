type QueryFilter = Record<string, any>;
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { CustomerModel } from "../customers/customer.model.js";
import { InvoiceModel } from "../invoices/invoice.model.js";
import { LedgerEntryModel } from "../invoices/ledger-entry.model.js";
import { PaymentModel } from "./payment.model.js";
import type {
  createPaymentSchema,
  paymentListQuerySchema,
  reversePaymentSchema,
} from "./payment.schemas.js";

type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
type ReverseInput = z.infer<typeof reversePaymentSchema>;
type ListQuery = z.infer<typeof paymentListQuerySchema>;

export function presentPayment(payment: any) {
  return {
    id: payment._id.toString(),
    customerId: payment.customerId?._id
      ? payment.customerId._id.toString()
      : payment.customerId?.toString(),
    customer: payment.customerId?._id
      ? {
          id: payment.customerId._id.toString(),
          displayName: payment.customerId.displayName,
          companyName: payment.customerId.companyName,
        }
      : undefined,
    kind: payment.kind,
    reversesPaymentId: payment.reversesPaymentId
      ? payment.reversesPaymentId.toString()
      : null,
    paymentReference: payment.paymentReference,
    paymentDate: payment.paymentDate,
    mode: payment.mode,
    transactionReference: payment.transactionReference ?? "",
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    allocations: (payment.allocations ?? []).map((a: any) => ({
      invoiceId: a.invoiceId?._id ? a.invoiceId._id.toString() : a.invoiceId?.toString(),
      invoiceNumber: a.invoiceId?.invoiceNumber,
      bucket: a.bucket,
      amountMinor: a.amountMinor,
    })),
    fileAssetIds: (payment.fileAssetIds ?? []).map((f: any) =>
      f._id ? f._id.toString() : f.toString(),
    ),
    remarks: payment.remarks ?? "",
    status: payment.status,
    idempotencyKey: payment.idempotencyKey,
    reversedAt: payment.reversedAt ?? null,
    createdAt: payment.createdAt,
  };
}

export async function createPayment(
  actor: AuthContext,
  organizationId: string,
  input: CreatePaymentInput,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  // 1. Check idempotency key
  const existing = await PaymentModel.findOne({ organizationId, idempotencyKey });
  if (existing) {
    if (
      existing.amountMinor === input.amountMinor &&
      existing.customerId.toString() === input.customerId
    ) {
      return presentPayment(existing);
    }
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "A payment was already submitted with this idempotency key but different payload",
      409,
    );
  }

  // 2. Validate customer
  const customer = await CustomerModel.findOne({
    _id: input.customerId,
    organizationId,
    status: "active",
  });
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

  const invoices = await InvoiceModel.find({
    _id: { $in: invoiceIds },
    organizationId,
    customerId: customer._id,
    documentStatus: "issued",
  });

  if (invoices.length !== invoiceIds.length) {
    throw new AppError(
      "INVALID_STATE",
      "One or more invoices do not exist, do not belong to this customer, or are not issued",
      422,
    );
  }

  const invoiceMap = new Map<string, any>(invoices.map((inv) => [inv._id.toString(), inv]));
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

  let createdPayment: any;
  try {
    createdPayment = await PaymentModel.create({
      organizationId,
      customerId: customer._id,
      kind: "collection",
      reversesPaymentId: null,
      paymentReference: input.paymentReference,
      paymentDate: input.paymentDate,
      mode: input.mode,
      transactionReference: input.transactionReference ?? "",
      amountMinor: input.amountMinor,
      currency: "INR",
      allocations: input.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        bucket: "principal",
        amountMinor: a.amountMinor,
      })),
      fileAssetIds: input.fileAssetIds ?? [],
      remarks: input.remarks ?? "",
      status: "posted",
      idempotencyKey,
      reversedAt: null,
      recordedBy: actor.userId,
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const duplicate = await PaymentModel.findOne({ organizationId, idempotencyKey });
      if (duplicate && duplicate.amountMinor === input.amountMinor && duplicate.customerId.toString() === input.customerId) {
        return presentPayment(duplicate);
      }
      throw new AppError("IDEMPOTENCY_CONFLICT", "This payment request was already submitted", 409);
    }
    throw error;
  }

  const updatedInvoiceIds: string[] = [];
  try {
    for (const alloc of input.allocations) {
      const inv = invoiceMap.get(alloc.invoiceId)!;
      const update = await InvoiceModel.updateOne(
        {
          _id: inv._id,
          organizationId,
          documentStatus: "issued",
          outstandingMinor: { $gte: alloc.amountMinor },
        },
        { $inc: { outstandingMinor: -alloc.amountMinor }, $set: { updatedBy: actor.userId } },
      );
      if (update.modifiedCount !== 1) {
        throw new AppError("INVALID_STATE", `Invoice ${inv.invoiceNumber} no longer has enough outstanding balance`, 422);
      }
      updatedInvoiceIds.push(inv._id.toString());

      await LedgerEntryModel.create({
        organizationId,
        customerId: customer._id,
        invoiceId: inv._id,
        bucket: "principal",
        type: "payment_allocation",
        amountMinor: -alloc.amountMinor,
        paymentId: createdPayment._id,
        effectiveDate: input.paymentDate,
        recordedBy: actor.userId,
      });
    }
  } catch (error) {
    await LedgerEntryModel.deleteMany({ paymentId: createdPayment._id });
    for (const invoiceId of updatedInvoiceIds) {
      const allocation = input.allocations.find((item) => item.invoiceId === invoiceId)!;
      await InvoiceModel.updateOne(
        { _id: invoiceId, organizationId, documentStatus: "issued" },
        { $inc: { outstandingMinor: allocation.amountMinor }, $set: { updatedBy: actor.userId } },
      );
    }
    await PaymentModel.deleteOne({ _id: createdPayment._id });
    throw error;
  }

  await recordAudit({
    actor,
    action: "payment.recorded",
    entityType: "payment",
    entityId: createdPayment._id.toString(),
    organizationId,
    after: {
      paymentReference: input.paymentReference,
      amountMinor: input.amountMinor,
      mode: input.mode,
    },
    meta,
  });

  return presentPayment(createdPayment);
}

export async function reversePayment(
  actor: AuthContext,
  organizationId: string,
  paymentId: string,
  input: ReverseInput,
  idempotencyKey: string,
  meta: RequestMeta,
) {
  const priorReversal = await PaymentModel.findOne({ organizationId, idempotencyKey });
  if (priorReversal) {
    if (priorReversal.reversesPaymentId?.toString() === paymentId) {
      return presentPayment(priorReversal);
    }
    throw new AppError("IDEMPOTENCY_CONFLICT", "This reversal request key was already used", 409);
  }

  const original = await PaymentModel.findOne({ _id: paymentId, organizationId });
  if (!original) {
    throw new AppError("NOT_FOUND", "Payment not found", 404);
  }

  if (original.kind !== "collection") {
    throw new AppError("INVALID_STATE", "Only collection payments can be reversed", 422);
  }

  if (original.reversedAt) {
    throw new AppError("CONFLICT", "This payment has already been reversed", 409);
  }

  const reversedAt = new Date();
  const claimedOriginal = await PaymentModel.findOneAndUpdate(
    { _id: original._id, organizationId, kind: "collection", reversedAt: null },
    { $set: { reversedAt } },
    { new: true },
  );
  if (!claimedOriginal) {
    throw new AppError("CONFLICT", "This payment has already been reversed", 409);
  }

  const paymentDate = new Date().toISOString().slice(0, 10);
  let reversalPayment: any;
  const restoredAllocations: Array<{ invoiceId: string; amountMinor: number }> = [];
  try {
    reversalPayment = await PaymentModel.create({
      organizationId,
      customerId: original.customerId,
      kind: "reversal",
      reversesPaymentId: original._id,
      paymentReference: `REV-${original.paymentReference}`,
      paymentDate,
      mode: original.mode,
      transactionReference: original.transactionReference,
      amountMinor: original.amountMinor,
      currency: original.currency,
      allocations: original.allocations,
      fileAssetIds: [],
      remarks: `Reversal: ${input.reason}`,
      status: "posted",
      idempotencyKey,
      reversedAt: null,
      recordedBy: actor.userId,
    });

    for (const alloc of original.allocations) {
      const update = await InvoiceModel.updateOne(
        { _id: alloc.invoiceId, organizationId },
        { $inc: { outstandingMinor: alloc.amountMinor } },
      );
      if (update.matchedCount !== 1) {
        throw new AppError("NOT_FOUND", "An invoice from this payment no longer exists", 404);
      }
      restoredAllocations.push({ invoiceId: alloc.invoiceId.toString(), amountMinor: alloc.amountMinor });

      await LedgerEntryModel.create({
        organizationId,
        customerId: original.customerId,
        invoiceId: alloc.invoiceId,
        bucket: "principal",
        type: "payment_reversal",
        amountMinor: alloc.amountMinor,
        paymentId: reversalPayment._id,
        effectiveDate: paymentDate,
        recordedBy: actor.userId,
      });
    }
  } catch (error) {
    if (reversalPayment) {
      await LedgerEntryModel.deleteMany({ paymentId: reversalPayment._id });
      await PaymentModel.deleteOne({ _id: reversalPayment._id });
    }
    for (const allocation of restoredAllocations) {
      await InvoiceModel.updateOne(
        { _id: allocation.invoiceId, organizationId },
        { $inc: { outstandingMinor: -allocation.amountMinor } },
      );
    }
    await PaymentModel.updateOne(
      { _id: original._id, organizationId, reversedAt },
      { $set: { reversedAt: null } },
    );
    throw error;
  }

  await recordAudit({
    actor,
    action: "payment.reversed",
    entityType: "payment",
    entityId: original._id.toString(),
    organizationId,
    reason: input.reason,
    after: { reversalPaymentId: reversalPayment._id.toString() },
    meta,
  });

  return presentPayment(reversalPayment);
}

export async function listPayments(organizationId: string, query: ListQuery) {
  const filter: QueryFilter = { organizationId };

  if (query.customerId) filter.customerId = query.customerId;
  if (query.kind) filter.kind = query.kind;
  if (query.invoiceId) {
    filter["allocations.invoiceId"] = query.invoiceId;
  }
  if (query.fromDate || query.toDate) {
    const dateFilter: Record<string, string> = {};
    if (query.fromDate) dateFilter.$gte = query.fromDate;
    if (query.toDate) dateFilter.$lte = query.toDate;
    filter.paymentDate = dateFilter;
  }

  const sortOption: Record<string, 1 | -1> = {};
  if (query.sort.startsWith("-")) {
    sortOption[query.sort.slice(1)] = -1;
  } else {
    sortOption[query.sort] = 1;
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    PaymentModel.find(filter)
      .populate("customerId", "displayName companyName")
      .populate("allocations.invoiceId", "invoiceNumber")
      .sort(sortOption)
      .skip(skip)
      .limit(query.limit),
    PaymentModel.countDocuments(filter),
  ]);

  return {
    items: items.map(presentPayment),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getPayment(organizationId: string, paymentId: string) {
  const payment = await PaymentModel.findOne({ _id: paymentId, organizationId })
    .populate("customerId", "displayName companyName email phone")
    .populate("allocations.invoiceId", "invoiceNumber amountMinor dueDate");

  if (!payment) {
    throw new AppError("NOT_FOUND", "Payment not found", 404);
  }
  return presentPayment(payment);
}

export async function getInvoiceLedger(organizationId: string, invoiceId: string) {
  const entries = await LedgerEntryModel.find({ organizationId, invoiceId })
    .populate("recordedBy", "name email")
    .populate("paymentId", "paymentReference mode")
    .sort({ createdAt: 1 });

  return entries.map((e: any) => ({
    id: e._id.toString(),
    bucket: e.bucket,
    type: e.type,
    amountMinor: e.amountMinor,
    effectiveDate: e.effectiveDate,
    payment: e.paymentId
      ? { id: e.paymentId._id.toString(), reference: e.paymentId.paymentReference }
      : null,
    recordedBy: e.recordedBy
      ? { id: e.recordedBy._id.toString(), name: e.recordedBy.name }
      : null,
    createdAt: e.createdAt,
  }));
}
