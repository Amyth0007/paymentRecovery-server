type QueryFilter = Record<string, any>;
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { CustomerModel } from "../customers/customer.model.js";
import { InvoiceModel } from "../invoices/invoice.model.js";
import { RecoveryAssignmentModel } from "../recovery/recovery-assignment.model.js";
import { RecoveryVisitModel } from "../recovery/recovery-visit.model.js";
import { CommitmentModel } from "./commitment.model.js";
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

export function presentCommitment(c: any) {
  return {
    id: c._id.toString(),
    customerId: c.customerId?._id ? c.customerId._id.toString() : c.customerId?.toString(),
    customer: c.customerId?._id
      ? {
          id: c.customerId._id.toString(),
          displayName: c.customerId.displayName,
          companyName: c.customerId.companyName,
        }
      : undefined,
    invoices: (c.invoiceIds ?? []).map((inv: any) =>
      inv._id
        ? {
            id: inv._id.toString(),
            invoiceNumber: inv.invoiceNumber,
            amountMinor: inv.amountMinor,
            outstandingMinor: inv.outstandingMinor,
          }
        : { id: inv.toString() },
    ),
    promisedAmountMinor: c.promisedAmountMinor,
    promisedDate: c.promisedDate,
    delayReason: c.delayReason ?? "",
    responsiblePerson: c.responsiblePerson,
    recordedBy: c.recordedBy?._id ? c.recordedBy._id.toString() : c.recordedBy?.toString(),
    fileAssetIds: (c.fileAssetIds ?? []).map((f: any) =>
      f._id ? f._id.toString() : f.toString(),
    ),
    sourceVisitId: c.sourceVisitId ? c.sourceVisitId.toString() : null,
    status: c.status,
    fulfilledAmountMinor: c.fulfilledAmountMinor ?? 0,
    evaluatedAt: c.evaluatedAt ?? null,
    cancelReason: c.cancelReason ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function createCommitment(
  actor: AuthContext,
  organizationId: string,
  input: CreateInput,
  meta: RequestMeta,
) {
  if (actor.role === "field_recovery") {
    const assignment = await RecoveryAssignmentModel.findOne({
      organizationId,
      assigneeId: actor.userId,
      customerId: input.customerId,
      invoiceIds: { $all: input.invoiceIds },
    });
    if (!assignment) {
      throw new AppError("FORBIDDEN", "Commitments can only be recorded for your assigned recovery work", 403);
    }
    if (input.sourceVisitId) {
      const visit = await RecoveryVisitModel.exists({
        _id: input.sourceVisitId,
        organizationId,
        assignmentId: assignment._id,
        employeeId: actor.userId,
      });
      if (!visit) {
        throw new AppError("FORBIDDEN", "The selected visit does not belong to your assigned work", 403);
      }
    }
  }

  const customer = await CustomerModel.findOne({
    _id: input.customerId,
    organizationId,
    status: "active",
  });
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found or not active", 404);
  }

  const invoices = await InvoiceModel.find({
    _id: { $in: input.invoiceIds },
    organizationId,
    customerId: customer._id,
    documentStatus: "issued",
  });
  if (invoices.length !== input.invoiceIds.length) {
    throw new AppError("INVALID_STATE", "One or more invoices do not belong to this customer", 422);
  }

  const commitment = await CommitmentModel.create({
    organizationId,
    customerId: customer._id,
    invoiceIds: input.invoiceIds,
    promisedAmountMinor: input.promisedAmountMinor,
    promisedDate: input.promisedDate,
    delayReason: input.delayReason ?? "",
    responsiblePerson: input.responsiblePerson,
    recordedBy: actor.userId,
    fileAssetIds: input.fileAssetIds ?? [],
    sourceVisitId: input.sourceVisitId ?? null,
    status: "upcoming",
  });

  await recordAudit({
    actor,
    action: "commitment.created",
    entityType: "commitment",
    entityId: commitment._id.toString(),
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
  const commitment = await CommitmentModel.findOne({ _id: commitmentId, organizationId });
  if (!commitment) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }

  if (commitment.status !== "upcoming") {
    throw new AppError(
      "INVALID_STATE",
      `Only 'upcoming' commitments can be cancelled. Current: ${commitment.status}`,
      422,
    );
  }

  const before = { status: commitment.status };
  commitment.status = "cancelled";
  commitment.cancelReason = input.reason;
  await commitment.save();

  await recordAudit({
    actor,
    action: "commitment.cancelled",
    entityType: "commitment",
    entityId: commitment._id.toString(),
    organizationId,
    before,
    after: { status: "cancelled" },
    reason: input.reason,
    meta,
  });

  return presentCommitment(commitment);
}

export async function evaluateCommitment(
  actor: AuthContext,
  organizationId: string,
  commitmentId: string,
  input: EvaluateInput,
  meta: RequestMeta,
) {
  const commitment = await CommitmentModel.findOne({ _id: commitmentId, organizationId });
  if (!commitment) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }

  const before = { status: commitment.status, fulfilledAmountMinor: commitment.fulfilledAmountMinor };
  commitment.status = input.status;
  commitment.fulfilledAmountMinor = input.fulfilledAmountMinor;
  commitment.evaluatedAt = new Date();
  await commitment.save();

  await recordAudit({
    actor,
    action: "commitment.evaluated",
    entityType: "commitment",
    entityId: commitment._id.toString(),
    organizationId,
    before,
    after: { status: commitment.status, fulfilledAmountMinor: commitment.fulfilledAmountMinor },
    meta,
  });

  return presentCommitment(commitment);
}

export async function listCommitments(organizationId: string, query: ListQuery) {
  const filter: QueryFilter = { organizationId };

  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.fromDate || query.toDate) {
    const dFilter: Record<string, string> = {};
    if (query.fromDate) dFilter.$gte = query.fromDate;
    if (query.toDate) dFilter.$lte = query.toDate;
    filter.promisedDate = dFilter;
  }

  const sortOption: Record<string, 1 | -1> = {};
  if (query.sort.startsWith("-")) {
    sortOption[query.sort.slice(1)] = -1;
  } else {
    sortOption[query.sort] = 1;
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    CommitmentModel.find(filter)
      .populate("customerId", "displayName companyName")
      .populate("invoiceIds", "invoiceNumber amountMinor outstandingMinor")
      .sort(sortOption)
      .skip(skip)
      .limit(query.limit),
    CommitmentModel.countDocuments(filter),
  ]);

  return {
    items: items.map(presentCommitment),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getCommitment(organizationId: string, commitmentId: string) {
  const commitment = await CommitmentModel.findOne({ _id: commitmentId, organizationId })
    .populate("customerId", "displayName companyName phone email")
    .populate("invoiceIds", "invoiceNumber amountMinor outstandingMinor dueDate")
    .populate("recordedBy", "name email");

  if (!commitment) {
    throw new AppError("NOT_FOUND", "Commitment not found", 404);
  }

  return presentCommitment(commitment);
}
