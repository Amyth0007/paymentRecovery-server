import { Schema, model } from "mongoose";

const settingsSchema = new Schema(
  {
    acknowledgementEvidenceRequired: { type: Boolean, default: false },
    pauseRemindersWhenDisputed: { type: Boolean, default: false },
    reminderSendHourLocal: { type: Number, default: 9, min: 0, max: 23 },
    commitmentGraceDays: { type: Number, default: 0, min: 0 },
    fieldLocationCapture: { type: String, enum: ["off", "optional"], default: "off" },
    autoFollowUpOnMissedCommitment: { type: Boolean, default: true },
  },
  { _id: false },
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, default: "", trim: true },
    gstin: { type: String, default: null },
    timezone: { type: String, required: true, default: "Asia/Kolkata" },
    currency: { type: String, required: true, default: "INR" },
    status: {
      type: String,
      required: true,
      enum: ["active", "suspended", "deactivated"],
      default: "active",
    },
    settings: { type: settingsSchema, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

organizationSchema.index({ status: 1, name: 1 });

export const OrganizationModel = model("Organization", organizationSchema);

const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export const SubscriptionPlanModel = model("SubscriptionPlan", planSchema);

const subscriptionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
    planId: { type: Schema.Types.ObjectId, ref: "SubscriptionPlan", required: true },
    status: {
      type: String,
      required: true,
      enum: ["trial", "active", "past_due", "cancelled"],
    },
    startedOn: { type: String, required: true },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

export const OrganizationSubscriptionModel = model("OrganizationSubscription", subscriptionSchema);
