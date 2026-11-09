import { Schema, model } from "mongoose";

const recoveryCallAttemptSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: "RecoveryAssignment", required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
  customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  attemptedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });

recoveryCallAttemptSchema.index({ organizationId: 1, assignmentId: 1, invoiceId: 1, attemptedAt: -1 });
export const RecoveryCallAttemptModel = model("RecoveryCallAttempt", recoveryCallAttemptSchema);
