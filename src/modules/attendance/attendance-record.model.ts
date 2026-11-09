import { Schema, model } from "mongoose";

const punchSchema = new Schema({
  at: { type: Date, required: true },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  gpsAccuracyM: { type: Number, default: null },
  officeDistanceM: { type: Number, default: null },
  locationVerification: { type: String, enum: ["verified", "not_enforced"], required: true },
  photoAssetId: { type: Schema.Types.ObjectId, ref: "FileAsset", required: true },
}, { _id: false });

const attendanceRecordSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  attendanceDate: { type: String, required: true },
  officeLocationId: { type: Schema.Types.ObjectId, ref: "OfficeLocation", default: null },
  checkIn: { type: punchSchema, default: null },
  checkOut: { type: punchSchema, default: null },
  status: { type: String, enum: ["checked_in", "completed"], required: true, default: "checked_in" },
  lateArrival: { type: Boolean, required: true, default: false },
  totalWorkingMinutes: { type: Number, default: null, min: 0 },
  correctedCheckOutAt: { type: Date, default: null },
  correctionId: { type: Schema.Types.ObjectId, ref: "AttendanceCorrection", default: null },
  halfDay: { type: Boolean, required: true, default: false },
}, { timestamps: true });

attendanceRecordSchema.index({ organizationId: 1, employeeId: 1, attendanceDate: 1 }, { unique: true });
attendanceRecordSchema.index({ organizationId: 1, attendanceDate: 1, status: 1 });
export const AttendanceRecordModel = model("AttendanceRecord", attendanceRecordSchema);
