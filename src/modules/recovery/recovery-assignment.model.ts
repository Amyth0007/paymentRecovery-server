import { Schema, model } from "mongoose";

export const ASSIGNMENT_STATUSES = [
  "not_assigned",
  "assigned",
  "in_progress",
  "visit_scheduled",
  "visit_completed",
  "follow_up_required",
  "payment_committed",
  "partially_recovered",
  "fully_recovered",
  "escalated",
  "closed",
] as const;

export const RECOVERY_PRIORITIES = ["low", "medium", "high"] as const;

const recoveryAssignmentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: "Invoice", required: true }],
    outstandingSnapshotMinor: { type: Number, required: true },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedOn: { type: String, required: true }, // YYYY-MM-DD
    visitDeadline: { type: String, required: true }, // YYYY-MM-DD
    priority: { type: String, required: true, enum: RECOVERY_PRIORITIES, default: "medium" },
    instructions: { type: String, default: "", trim: true },
    status: {
      type: String,
      required: true,
      enum: ASSIGNMENT_STATUSES,
      default: "assigned",
    },
    closeReason: { type: String, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

recoveryAssignmentSchema.index({ organizationId: 1, assigneeId: 1, status: 1 });
recoveryAssignmentSchema.index({ organizationId: 1, customerId: 1 });
recoveryAssignmentSchema.index({ organizationId: 1, status: 1 });

export const RecoveryAssignmentModel = model(
  "RecoveryAssignment",
  recoveryAssignmentSchema,
);
