import { Schema, model } from "mongoose";

const FILE_PURPOSES = [
  "invoice_document",
  "acknowledgement_evidence",
  "payment_support",
  "visit_evidence",
  "commitment_evidence",
] as const;

const fileAssetSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    purpose: { type: String, required: true, enum: FILE_PURPOSES },
    originalFilename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    storagePath: { type: String, default: "" },
    storageUrl: { type: String, default: null },
    cloudinaryPublicId: { type: String, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

fileAssetSchema.index({ organizationId: 1, purpose: 1 });

export const FileAssetModel = model("FileAsset", fileAssetSchema);

export { FILE_PURPOSES };
