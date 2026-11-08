import { Schema, model } from "mongoose";

export const VISIT_OUTCOMES = [
  "promised_payment",
  "partial_payment_received",
  "payment_already_made",
  "payment_refused",
  "invoice_dispute",
  "goods_service_issue",
  "person_unavailable",
  "additional_time_requested",
  "business_closed",
  "other",
] as const;

const locationSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracyMeters: { type: Number, default: null },
  },
  { _id: false },
);

const recoveryVisitSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    assignmentId: { type: Schema.Types.ObjectId, ref: "RecoveryAssignment", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: "Invoice" }],
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    visitedAt: { type: Date, required: true, default: Date.now },
    contactPersonName: { type: String, required: true, trim: true },
    contactDesignation: { type: String, default: "", trim: true },
    outcome: { type: String, required: true, enum: VISIT_OUTCOMES },
    discussion: { type: String, required: true, trim: true },
    nonPaymentReason: { type: String, default: "", trim: true },
    promisedDate: { type: String, default: null }, // YYYY-MM-DD
    promisedAmountMinor: { type: Number, default: null },
    commitmentId: { type: Schema.Types.ObjectId, ref: "Commitment", default: null },
    fileAssetIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    location: { type: locationSchema, default: null },
    remarks: { type: String, default: "", trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

recoveryVisitSchema.index({ organizationId: 1, assignmentId: 1, createdAt: 1 });

export const RecoveryVisitModel = model("RecoveryVisit", recoveryVisitSchema);
