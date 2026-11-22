import { Schema, model } from "mongoose";

const departmentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true, uppercase: true, default: "" },
  managerEmployeeId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", default: null },
  status: { type: String, enum: ["active", "inactive"], default: "active", required: true },
}, { timestamps: true });

departmentSchema.index({ organizationId: 1, name: 1 }, { unique: true });
departmentSchema.index({ organizationId: 1, status: 1 });
export const DepartmentModel = model("Department", departmentSchema);
