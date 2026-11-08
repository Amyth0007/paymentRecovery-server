import { Schema, model } from "mongoose";

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByTokenId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema);
