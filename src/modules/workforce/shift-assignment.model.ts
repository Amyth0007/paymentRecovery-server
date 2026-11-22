import { Schema, model } from "mongoose";

const shiftAssignmentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true },
  shiftId: { type: Schema.Types.ObjectId, ref: "WorkforceShift", required: true },
  effectiveFrom: { type: String, required: true }, effectiveTo: { type: String, default: null },
  assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
shiftAssignmentSchema.index({ organizationId: 1, employeeId: 1, effectiveFrom: 1 }, { unique: true });
shiftAssignmentSchema.index({ organizationId: 1, shiftId: 1, effectiveFrom: 1 });
export const ShiftAssignmentModel = model("WorkforceShiftAssignment", shiftAssignmentSchema);
