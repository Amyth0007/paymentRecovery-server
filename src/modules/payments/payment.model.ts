import { Schema, model } from "mongoose";

const allocationSchema = new Schema(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    bucket: { type: String, required: true, enum: ["principal"], default: "principal" },
    amountMinor: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    kind: { type: String, required: true, enum: ["collection", "reversal"], default: "collection" },
    reversesPaymentId: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
    paymentReference: { type: String, required: true, trim: true },
    paymentDate: { type: String, required: true }, // YYYY-MM-DD
    mode: {
      type: String,
      required: true,
      enum: ["bank_transfer", "upi", "cheque", "cash", "card", "other"],
      default: "bank_transfer",
    },
    transactionReference: { type: String, default: "", trim: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: "INR" },
    allocations: { type: [allocationSchema], required: true },
    fileAssetIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    remarks: { type: String, default: "", trim: true },
    status: { type: String, required: true, enum: ["posted"], default: "posted" },
    idempotencyKey: { type: String, required: true },
    reversedAt: { type: Date, default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

paymentSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ organizationId: 1, customerId: 1, paymentDate: 1 });
paymentSchema.index({ organizationId: 1, "allocations.invoiceId": 1 });

export const PaymentModel = model("Payment", paymentSchema);
