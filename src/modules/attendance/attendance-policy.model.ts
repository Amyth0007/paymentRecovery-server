import { Schema, model } from "mongoose";

const attendancePolicySchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
  expectedCheckIn: { type: String, required: true, default: "09:00" },
  expectedCheckOut: { type: String, required: true, default: "17:00" },
  gracePeriodMinutes: { type: Number, required: true, default: 10, min: 0, max: 240 },
  halfDayHours: { type: Number, required: true, default: 4, min: 1, max: 12 },
  gpsAccuracyThresholdM: { type: Number, required: true, default: 50, min: 5, max: 500 },
  weeklyHolidays: { type: [Number], default: [0], validate: (days: number[]) => days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) },
  correctionRequestsEnabled: { type: Boolean, required: true, default: true },
}, { timestamps: true });

export const AttendancePolicyModel = model("AttendancePolicy", attendancePolicySchema);
