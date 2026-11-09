import { Schema, model } from "mongoose";

const gmailEmailSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },
  senderEmail: { type: String, required: true, lowercase: true },
  recipientEmail: { type: String, required: true, lowercase: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  sentAt: { type: Date, required: true },
  gmailMessageId: { type: String, default: null },
  status: { type: String, enum: ["sent", "failed"], required: true },
  failureReason: { type: String, default: null },
}, { timestamps: true });

gmailEmailSchema.index({ organizationId: 1, createdAt: -1 });
gmailEmailSchema.index({ organizationId: 1, invoiceId: 1, createdAt: -1 });
export const GmailEmailModel = model("GmailEmail", gmailEmailSchema);
