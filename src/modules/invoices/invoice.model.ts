import { Schema, model } from "mongoose";

const partySnapshotSchema = new Schema(
  {
    displayName: { type: String, required: true },
    companyName: { type: String, default: "" },
    gstin: { type: String, default: null },
    billingAddress: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const cancellationSchema = new Schema(
  {
    reason: { type: String, required: true },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    cancelledAt: { type: Date, required: true },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: String, required: true }, // YYYY-MM-DD
    dueDate: { type: String, required: true }, // YYYY-MM-DD
    creditDays: { type: Number, default: null },
    termSource: { type: String, required: true, enum: ["credit_days", "explicit_date"] },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: "INR" },
    outstandingMinor: { type: Number, required: true, default: 0 },
    documentStatus: {
      type: String,
      required: true,
      enum: ["draft", "issued", "cancelled"],
      default: "draft",
    },
    acknowledgementStatus: {
      type: String,
      required: true,
      enum: ["not_shared", "shared", "acknowledged", "rejected", "disputed"],
      default: "not_shared",
    },
    partySnapshot: { type: partySnapshotSchema, default: null },
    notes: { type: String, default: "", trim: true },
    cancellation: { type: cancellationSchema, default: null },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    primaryFileAssetId: { type: Schema.Types.ObjectId, ref: "FileAsset", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

invoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ organizationId: 1, customerId: 1, documentStatus: 1 });
invoiceSchema.index({ organizationId: 1, dueDate: 1, documentStatus: 1 });
invoiceSchema.index({ organizationId: 1, documentStatus: 1, outstandingMinor: 1 });

export const InvoiceModel = model("Invoice", invoiceSchema);
