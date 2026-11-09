import { Schema, model } from "mongoose";

const gmailOAuthStateSchema = new Schema({
  stateHash: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export const GmailOAuthStateModel = model("GmailOAuthState", gmailOAuthStateSchema);
