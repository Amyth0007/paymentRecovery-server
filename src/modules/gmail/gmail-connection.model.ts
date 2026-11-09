import { Schema, model } from "mongoose";

const gmailConnectionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
  connectedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  provider: { type: String, enum: ["google"], default: "google", required: true },
  googleAccountId: { type: String, required: true },
  email: { type: String, required: true, lowercase: true },
  encryptedRefreshToken: { type: String, required: true, select: false },
  status: { type: String, enum: ["connected", "reauthorization_required", "disconnected"], default: "connected", required: true },
  connectedAt: { type: Date, required: true },
  lastSuccessfulEmailAt: { type: Date, default: null },
}, { timestamps: true });

export const GmailConnectionModel = model("GmailConnection", gmailConnectionSchema);
