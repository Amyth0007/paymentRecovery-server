import { Schema, model } from "mongoose";

const leaveTypeSchema = new Schema({ organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, code: { type: String, required: true, trim: true, uppercase: true }, name: { type: String, required: true, trim: true }, paid: { type: Boolean, required: true, default: true }, annualEntitlementDays: { type: Number, min: 0, max: 366, required: true, default: 0 }, status: { type: String, enum: ["active", "inactive"], default: "active" } }, { timestamps: true });
leaveTypeSchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const LeaveTypeModel = model("LeaveType", leaveTypeSchema);

const leaveBalanceSchema = new Schema({ organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, employeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true }, leaveTypeId: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true }, year: { type: Number, required: true }, entitlementDays: { type: Number, min: 0, required: true }, usedDays: { type: Number, min: 0, default: 0 } }, { timestamps: true });
leaveBalanceSchema.index({ organizationId: 1, employeeId: 1, leaveTypeId: 1, year: 1 }, { unique: true });
export const LeaveBalanceModel = model("LeaveBalance", leaveBalanceSchema);

const leaveRequestSchema = new Schema({ organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, employeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true }, leaveTypeId: { type: Schema.Types.ObjectId, ref: "LeaveType", required: true }, startDate: { type: String, required: true }, endDate: { type: String, required: true }, days: { type: Number, min: 0.5, required: true }, reason: { type: String, required: true, trim: true }, status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" }, reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null }, reviewedAt: { type: Date, default: null }, reviewComment: { type: String, default: "" } }, { timestamps: true });
leaveRequestSchema.index({ organizationId: 1, employeeId: 1, startDate: 1, endDate: 1, status: 1 });
leaveRequestSchema.index({ organizationId: 1, status: 1, startDate: 1 });
export const LeaveRequestModel = model("LeaveRequest", leaveRequestSchema);
