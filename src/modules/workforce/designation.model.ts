import { Schema, model } from "mongoose";

const designationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: "", trim: true },
  status: { type: String, enum: ["active", "inactive"], default: "active", required: true },
}, { timestamps: true });

designationSchema.index({ organizationId: 1, name: 1 }, { unique: true });
designationSchema.index({ organizationId: 1, status: 1 });
export const DesignationModel = model("Designation", designationSchema);
