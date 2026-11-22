import { Schema, model } from "mongoose";

const componentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  code: { type: String, required: true, uppercase: true, trim: true }, name: { type: String, required: true, trim: true },
  kind: { type: String, enum: ["earning", "deduction", "employer_contribution"], required: true },
  calculation: { type: String, enum: ["fixed", "percentage"], required: true },
  amountMinor: { type: Number, default: 0, min: 0 }, rateBasisPoints: { type: Number, default: 0, min: 0, max: 100000 }, basisComponentCode: { type: String, default: "" },
  effectiveFrom: { type: String, required: true }, effectiveTo: { type: String, default: null }, status: { type: String, enum: ["active", "inactive"], default: "active" },
}, { timestamps: true });
componentSchema.index({ organizationId: 1, code: 1, effectiveFrom: 1 }, { unique: true });
export const CompensationComponentModel = model("CompensationComponent", componentSchema);

const structureLineSchema = new Schema({ componentId: { type: Schema.Types.ObjectId, ref: "CompensationComponent", required: true }, code: { type: String, required: true }, name: { type: String, required: true }, kind: { type: String, enum: ["earning", "deduction", "employer_contribution"], required: true }, calculation: { type: String, enum: ["fixed", "percentage"], required: true }, amountMinor: { type: Number, min: 0, default: 0 }, rateBasisPoints: { type: Number, min: 0, max: 100000, default: 0 }, basisComponentCode: { type: String, default: "" } }, { _id: false });
const structureSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, name: { type: String, required: true, trim: true },
  mode: { type: String, enum: ["simple", "professional"], required: true }, payBasis: { type: String, enum: ["monthly", "daily", "hourly", "shift", "piece"], required: true },
  baseRateMinor: { type: Number, required: true, min: 0 }, components: { type: [structureLineSchema], default: [] },
  effectiveFrom: { type: String, required: true }, effectiveTo: { type: String, default: null }, status: { type: String, enum: ["active", "inactive"], default: "active" },
}, { timestamps: true });
structureSchema.index({ organizationId: 1, name: 1, effectiveFrom: 1 }, { unique: true });
export const PayStructureModel = model("PayStructure", structureSchema);

const assignmentSchema = new Schema({ organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, employeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true }, structureId: { type: Schema.Types.ObjectId, ref: "PayStructure", required: true }, effectiveFrom: { type: String, required: true }, effectiveTo: { type: String, default: null }, assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, rateSnapshot: { type: Schema.Types.Mixed, required: true } }, { timestamps: true });
assignmentSchema.index({ organizationId: 1, employeeId: 1, effectiveFrom: 1 }, { unique: true });
export const CompensationAssignmentModel = model("CompensationAssignment", assignmentSchema);

const dailyEarningSchema = new Schema({ organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true }, employeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", required: true }, earningDate: { type: String, required: true }, source: { type: String, enum: ["attendance", "overtime", "task", "piece_rate", "bonus", "manual", "adjustment"], required: true }, description: { type: String, required: true, trim: true }, quantityThousandths: { type: Number, required: true, min: 0 }, rateMinor: { type: Number, required: true, min: 0 }, amountMinor: { type: Number, required: true, min: 0 }, currency: { type: String, required: true }, status: { type: String, enum: ["pending", "approved", "rejected", "paid"], default: "pending" }, createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true }, adjustmentOf: { type: Schema.Types.ObjectId, ref: "DailyEarning", default: null } }, { timestamps: true });
dailyEarningSchema.index({ organizationId: 1, employeeId: 1, earningDate: 1, status: 1 });
export const DailyEarningModel = model("DailyEarning", dailyEarningSchema);
