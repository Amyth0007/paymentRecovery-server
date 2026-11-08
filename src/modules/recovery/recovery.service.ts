type QueryFilter = Record<string, any>;
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { CustomerModel } from "../customers/customer.model.js";
import { InvoiceModel } from "../invoices/invoice.model.js";
import { UserModel } from "../users/user.model.js";
import { RecoveryAssignmentModel } from "./recovery-assignment.model.js";
import { RecoveryVisitModel } from "./recovery-visit.model.js";
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

export function presentAssignment(assignment: any) {
  return {
    id: assignment._id.toString(),
    customerId: assignment.customerId?._id
      ? assignment.customerId._id.toString()
      : assignment.customerId?.toString(),
    customer: assignment.customerId?._id
      ? {
          id: assignment.customerId._id.toString(),
          displayName: assignment.customerId.displayName,
          companyName: assignment.customerId.companyName,
          phone: assignment.customerId.phone,
        }
      : undefined,
    invoices: (assignment.invoiceIds ?? []).map((inv: any) =>
      inv._id
        ? {
            id: inv._id.toString(),
            invoiceNumber: inv.invoiceNumber,
            amountMinor: inv.amountMinor,
            outstandingMinor: inv.outstandingMinor,
            dueDate: inv.dueDate,
          }
        : { id: inv.toString() },
    ),
    outstandingSnapshotMinor: assignment.outstandingSnapshotMinor,
    assigneeId: assignment.assigneeId?._id
      ? assignment.assigneeId._id.toString()
      : assignment.assigneeId?.toString(),
    assignee: assignment.assigneeId?._id
      ? {
          id: assignment.assigneeId._id.toString(),
          name: assignment.assigneeId.name,
          email: assignment.assigneeId.email,
        }
      : undefined,
    assignedBy: assignment.assignedBy?._id
      ? assignment.assignedBy._id.toString()
      : assignment.assignedBy?.toString(),
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

export function presentVisit(visit: any) {
  return {
    id: visit._id.toString(),
    assignmentId: visit.assignmentId.toString(),
    customerId: visit.customerId.toString(),
    employeeId: visit.employeeId?._id
      ? visit.employeeId._id.toString()
      : visit.employeeId?.toString(),
    employee: visit.employeeId?._id
      ? {
          id: visit.employeeId._id.toString(),
          name: visit.employeeId.name,
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
    commitmentId: visit.commitmentId ? visit.commitmentId.toString() : null,
    fileAssetIds: (visit.fileAssetIds ?? []).map((f: any) =>
      f._id ? f._id.toString() : f.toString(),
    ),
    location: visit.location ?? null,
    remarks: visit.remarks ?? "",
    createdAt: visit.createdAt,
  };
}

export async function createAssignment(
  actor: AuthContext,
  organizationId: string,
  input: CreateAssignmentInput,
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

  const invoices = await InvoiceModel.find({
    _id: { $in: input.invoiceIds },
    organizationId,
    customerId: customer._id,
    documentStatus: "issued",
    outstandingMinor: { $gt: 0 },
  });

  if (invoices.length !== input.invoiceIds.length) {
    throw new AppError(
      "INVALID_STATE",
      "One or more invoices do not exist, do not belong to customer, or have no outstanding balance",
      422,
    );
  }

  const assignee = await UserModel.findOne({
    _id: input.assigneeId,
    organizationId,
    status: "active",
  });
  if (!assignee) {
    throw new AppError("NOT_FOUND", "Assignee user not found or disabled", 404);
  }

  const outstandingSnapshotMinor = invoices.reduce((sum, inv) => sum + inv.outstandingMinor, 0);

  const assignment = await RecoveryAssignmentModel.create({
    organizationId,
    customerId: customer._id,
    invoiceIds: input.invoiceIds,
    outstandingSnapshotMinor,
    assigneeId: assignee._id,
    assignedBy: actor.userId,
    assignedOn: new Date().toISOString().slice(0, 10),
    visitDeadline: input.visitDeadline,
    priority: input.priority,
    instructions: input.instructions ?? "",
    status: "assigned",
  });

  await recordAudit({
    actor,
    action: "recovery.assigned",
    entityType: "recovery_assignment",
    entityId: assignment._id.toString(),
    organizationId,
    after: {
      customerId: customer._id.toString(),
      assigneeId: assignee._id.toString(),
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
  const assignmentFilter: QueryFilter = { _id: assignmentId, organizationId };
  if (actor.role === "field_recovery") assignmentFilter.assigneeId = actor.userId;
  const assignment = await RecoveryAssignmentModel.findOne(assignmentFilter);
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  if (input.status === "fully_recovered") {
    const invoices = await InvoiceModel.find({
      _id: { $in: assignment.invoiceIds },
      organizationId,
    });
    const hasRemaining = invoices.some((inv) => inv.outstandingMinor > 0);
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

  assignment.status = input.status;
  if (input.instructions !== undefined) assignment.instructions = input.instructions;
  if (input.assigneeId) assignment.assigneeId = input.assigneeId as any;

  if (input.status === "closed") {
    assignment.closeReason = input.closeReason ?? "";
    assignment.closedAt = new Date();
  }

  await assignment.save();

  await recordAudit({
    actor,
    action: "recovery.status_changed",
    entityType: "recovery_assignment",
    entityId: assignment._id.toString(),
    organizationId,
    before,
    after: { status: assignment.status },
    reason: input.closeReason,
    meta,
  });

  return presentAssignment(assignment);
}

export async function createVisit(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
  input: CreateVisitInput,
  meta: RequestMeta,
) {
  const assignment = await RecoveryAssignmentModel.findOne({
    _id: assignmentId,
    organizationId,
  });
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  const visit = await RecoveryVisitModel.create({
    organizationId,
    assignmentId: assignment._id,
    customerId: assignment.customerId,
    invoiceIds: assignment.invoiceIds,
    employeeId: actor.userId,
    visitedAt: new Date(),
    contactPersonName: input.contactPersonName,
    contactDesignation: input.contactDesignation ?? "",
    outcome: input.outcome,
    discussion: input.discussion,
    nonPaymentReason: input.nonPaymentReason ?? "",
    promisedDate: input.promisedDate ?? null,
    promisedAmountMinor: input.promisedAmountMinor ?? null,
    fileAssetIds: input.fileAssetIds ?? [],
    location: input.location ?? null,
    remarks: input.remarks ?? "",
  });

  // Auto transition assignment status based on visit outcome if appropriate
  if (input.outcome === "promised_payment") {
    assignment.status = "payment_committed";
    await assignment.save();
  } else if (assignment.status === "assigned" || assignment.status === "visit_scheduled") {
    assignment.status = "visit_completed";
    await assignment.save();
  }

  await recordAudit({
    actor,
    action: "recovery.visit_recorded",
    entityType: "recovery_visit",
    entityId: visit._id.toString(),
    organizationId,
    after: { outcome: visit.outcome, contactPersonName: visit.contactPersonName },
    meta,
  });

  return presentVisit(visit);
}

export async function listAssignments(
  actor: AuthContext,
  organizationId: string,
  query: ListQuery,
) {
  const filter: QueryFilter = { organizationId };

  // Field recovery employees see only assignments given to them
  if (actor.role === "field_recovery") {
    filter.assigneeId = actor.userId;
  } else if (query.assigneeId) {
    filter.assigneeId = query.assigneeId;
  }

  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.fromDate || query.toDate) {
    filter.createdAt = {
      ...(query.fromDate ? { $gte: new Date(`${query.fromDate}T00:00:00.000Z`) } : {}),
      ...(query.toDate ? { $lte: new Date(`${query.toDate}T23:59:59.999Z`) } : {}),
    };
  }

  const sortOption: Record<string, 1 | -1> = {};
  if (query.sort.startsWith("-")) {
    sortOption[query.sort.slice(1)] = -1;
  } else {
    sortOption[query.sort] = 1;
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    RecoveryAssignmentModel.find(filter)
      .populate("customerId", "displayName companyName phone")
      .populate("assigneeId", "name email")
      .populate("invoiceIds", "invoiceNumber amountMinor outstandingMinor dueDate")
      .sort(sortOption)
      .skip(skip)
      .limit(query.limit),
    RecoveryAssignmentModel.countDocuments(filter),
  ]);

  return {
    items: items.map(presentAssignment),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getAssignment(
  actor: AuthContext,
  organizationId: string,
  assignmentId: string,
) {
  const filter: QueryFilter = { _id: assignmentId, organizationId };
  if (actor.role === "field_recovery") {
    filter.assigneeId = actor.userId;
  }

  const assignment = await RecoveryAssignmentModel.findOne(filter)
    .populate("customerId", "displayName companyName phone billingAddress")
    .populate("assigneeId", "name email")
    .populate("assignedBy", "name")
    .populate("invoiceIds", "invoiceNumber amountMinor outstandingMinor dueDate");

  if (!assignment) {
    throw new AppError("NOT_FOUND", "Assignment not found", 404);
  }

  const visits = await RecoveryVisitModel.find({
    organizationId,
    assignmentId: assignment._id,
  })
    .populate("employeeId", "name email")
    .populate("fileAssetIds", "originalFilename mimeType sizeBytes")
    .sort({ createdAt: -1 });

  return {
    assignment: presentAssignment(assignment),
    visits: visits.map(presentVisit),
  };
}

export async function listVisits(actor: AuthContext, organizationId: string, assignmentId: string) {
  const assignmentFilter: QueryFilter = { _id: assignmentId, organizationId };
  if (actor.role === "field_recovery") assignmentFilter.assigneeId = actor.userId;
  const assignment = await RecoveryAssignmentModel.findOne(assignmentFilter).select("_id");
  if (!assignment) {
    throw new AppError("NOT_FOUND", "Recovery assignment not found", 404);
  }

  const visits = await RecoveryVisitModel.find({
    organizationId,
    assignmentId: assignment._id,
  })
    .populate("employeeId", "name email")
    .sort({ createdAt: -1 });

  return visits.map(presentVisit);
}
