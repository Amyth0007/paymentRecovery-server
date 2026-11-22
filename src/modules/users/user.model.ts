import { Schema, model } from "mongoose";
import { ROLES } from "../../common/auth/auth-context.js";

const userSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ROLES },
    modulePermissions: { type: Map, of: Boolean, default: () => new Map() },
    modulePermissionsConfigured: { type: Boolean, required: true, default: false },
    actionPermissions: { type: [String], default: [] },
    customRoleId: { type: Schema.Types.ObjectId, ref: "CustomRole", default: null },
    workforceScope: { mode: { type: String, enum: ["organization", "selected"], default: "organization" }, departmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "Department" }], default: [] }, locationIds: { type: [{ type: Schema.Types.ObjectId, ref: "OfficeLocation" }], default: [] } },
    status: { type: String, required: true, enum: ["active", "disabled"], default: "active" },
    mustChangePassword: { type: Boolean, required: true, default: false },
    tokenVersion: { type: Number, required: true, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ organizationId: 1, status: 1 });
userSchema.index({ organizationId: 1, customRoleId: 1, status: 1 });

export const UserModel = model("User", userSchema);
