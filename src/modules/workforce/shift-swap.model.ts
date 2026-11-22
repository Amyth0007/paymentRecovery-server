import { Schema, model } from "mongoose";

const shiftSwapSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  requesterEmployeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true },
  targetEmployeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true },
  requesterShiftId: { type: Schema.Types.ObjectId, ref: "WorkforceShift", default: null },
  targetShiftId: { type: Schema.Types.ObjectId, ref: "WorkforceShift", default: null },
  shiftDate: { type: String, required: true },
  reason: { type: String, required: true, trim: true },
  status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], required: true, default: "pending" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reviewComment: { type: String, default: "" },
}, { timestamps: true });

shiftSwapSchema.index({ organizationId: 1, shiftDate: 1, status: 1 });
shiftSwapSchema.index({ organizationId: 1, requesterEmployeeId: 1, shiftDate: 1 });
shiftSwapSchema.index({ organizationId: 1, targetEmployeeId: 1, shiftDate: 1 });

export const ShiftSwapModel = model("WorkforceShiftSwap", shiftSwapSchema);
