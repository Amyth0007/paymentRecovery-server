import { Schema, model } from "mongoose";

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    designation: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true },
);

const addressSchema = new Schema(
  {
    line1: { type: String, default: "", trim: true },
    line2: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    postalCode: { type: String, default: "", trim: true },
    country: { type: String, default: "India", trim: true },
  },
  { _id: false },
);

const customerSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    displayName: { type: String, required: true, trim: true },
    companyName: { type: String, default: "", trim: true },
    gstin: { type: String, default: null, trim: true, uppercase: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    contacts: { type: [contactSchema], default: [] },
    billingAddress: { type: addressSchema, default: () => ({}) },
    businessAddress: { type: addressSchema, default: () => ({}) },
    defaultCreditDays: { type: Number, required: true, default: 30, min: 0, max: 365 },
    creditLimitMinor: { type: Number, default: null },
    notes: { type: String, default: "", trim: true },
    status: { type: String, required: true, enum: ["active", "archived"], default: "active" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

customerSchema.index({ organizationId: 1, status: 1, displayName: 1 });
customerSchema.index({ organizationId: 1, companyName: 1 });

export const CustomerModel = model("Customer", customerSchema);
