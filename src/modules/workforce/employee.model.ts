import { Schema, model } from "mongoose";

const employeeSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  employeeNumber: { type: String, required: true, trim: true, uppercase: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, default: "", trim: true },
  email: { type: String, default: "", lowercase: true, trim: true },
  phone: { type: String, default: "", trim: true },
  dateOfBirth: { type: String, default: null },
  joiningDate: { type: String, required: true },
  employmentType: { type: String, enum: ["permanent", "contract", "temporary", "daily_wage", "hourly", "part_time", "intern", "freelance"], required: true },
  status: { type: String, enum: ["active", "inactive", "on_leave", "terminated"], default: "active", required: true },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
  designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
  reportingManagerId: { type: Schema.Types.ObjectId, ref: "WorkforceEmployee", default: null },
  workLocationId: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
  notes: { type: String, default: "", maxlength: 2000 },
}, { timestamps: true });

employeeSchema.index({ organizationId: 1, employeeNumber: 1 }, { unique: true });
employeeSchema.index({ organizationId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } });
employeeSchema.index({ organizationId: 1, status: 1, departmentId: 1, lastName: 1, firstName: 1 });
employeeSchema.index({ organizationId: 1, email: 1 });
export const WorkforceEmployeeModel = model("WorkforceEmployee", employeeSchema);
