import { Schema, model } from "mongoose";

const invoiceAcknowledgementSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true },
    status: {
      type: String,
      required: true,
      enum: ["shared", "acknowledged", "rejected", "disputed"],
    },
    eventAt: { type: Date, required: true, default: Date.now },
    responsiblePersonName: { type: String, default: "", trim: true },
    responsiblePersonDesignation: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
    fileAssetIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

invoiceAcknowledgementSchema.index({ organizationId: 1, invoiceId: 1, createdAt: 1 });

export const InvoiceAcknowledgementModel = model(
  "InvoiceAcknowledgement",
  invoiceAcknowledgementSchema,
);
