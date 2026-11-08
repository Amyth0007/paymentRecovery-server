import { Schema, model } from "mongoose";

const ledgerEntrySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    bucket: { type: String, required: true, enum: ["principal", "interest"], default: "principal" },
    type: {
      type: String,
      required: true,
      enum: [
        "invoice_issued",
        "payment_allocation",
        "payment_reversal",
        "adjustment_credit",
        "adjustment_debit",
        "invoice_cancelled",
      ],
    },
    amountMinor: { type: Number, required: true }, // Signed integer paise
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
    effectiveDate: { type: String, required: true }, // YYYY-MM-DD
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ organizationId: 1, invoiceId: 1, createdAt: 1 });
ledgerEntrySchema.index({ organizationId: 1, customerId: 1, effectiveDate: 1 });

export const LedgerEntryModel = model("LedgerEntry", ledgerEntrySchema);
