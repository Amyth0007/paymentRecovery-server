import { Schema, model } from "mongoose";

const customRoleSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: "", trim: true, maxlength: 300 },
  modulePermissions: { type: [String], default: [] },
  actionPermissions: { type: [String], default: [] },
  status: { type: String, enum: ["active", "archived"], default: "active", required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

customRoleSchema.index({ organizationId: 1, name: 1 }, { unique: true });
customRoleSchema.index({ organizationId: 1, status: 1 });
export const CustomRoleModel = model("CustomRole", customRoleSchema);
