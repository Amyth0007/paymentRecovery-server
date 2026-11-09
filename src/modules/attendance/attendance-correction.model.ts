import { Schema, model } from "mongoose";

const attendanceCorrectionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  attendanceRecordId: { type: Schema.Types.ObjectId, ref: "AttendanceRecord", required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  requestedCheckInAt: { type: Date, default: null },
  requestedCheckOutAt: { type: Date, default: null },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  evidenceFileAssetId: { type: Schema.Types.ObjectId, ref: "FileAsset", default: null },
  status: { type: String, enum: ["pending", "approved", "rejected"], required: true, default: "pending" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reviewComment: { type: String, default: "", maxlength: 1000 },
  appliedChange: { type: Schema.Types.Mixed, default: null },
}, { timestamps: true });

attendanceCorrectionSchema.index({ organizationId: 1, employeeId: 1, createdAt: -1 });
attendanceCorrectionSchema.index({ organizationId: 1, status: 1, createdAt: 1 });
export const AttendanceCorrectionModel = model("AttendanceCorrection", attendanceCorrectionSchema);
