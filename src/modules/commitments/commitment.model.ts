import { Schema, model } from "mongoose";

export const COMMITMENT_STATUSES = [
  "upcoming",
  "fulfilled",
  "partially_fulfilled",
  "missed",
  "cancelled",
] as const;

const commitmentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: "Invoice", required: true }],
    promisedAmountMinor: { type: Number, required: true, min: 1 },
    promisedDate: { type: String, required: true }, // YYYY-MM-DD
    delayReason: { type: String, default: "", trim: true },
    responsiblePerson: { type: String, required: true, trim: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fileAssetIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    sourceVisitId: { type: Schema.Types.ObjectId, ref: "RecoveryVisit", default: null },
    status: {
      type: String,
      required: true,
      enum: COMMITMENT_STATUSES,
      default: "upcoming",
    },
    fulfilledAmountMinor: { type: Number, default: 0 },
    evaluatedAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true },
);

commitmentSchema.index({ organizationId: 1, status: 1, promisedDate: 1 });
commitmentSchema.index({ organizationId: 1, customerId: 1 });

export const CommitmentModel = model("Commitment", commitmentSchema);
