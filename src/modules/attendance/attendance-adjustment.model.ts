import { Schema, model } from "mongoose";

const snapshotSchema = new Schema({
  status: { type: String, enum: ["present", "absent", "leave"], required: true },
  checkInAt: { type: Date, default: null },
  checkOutAt: { type: Date, default: null },
  reason: { type: String, required: true },
}, { _id: false });

const historySchema = new Schema({
  before: { type: snapshotSchema, default: null },
  after: { type: snapshotSchema, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  at: { type: Date, required: true, default: Date.now },
}, { _id: false });

const attendanceAdjustmentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  attendanceDate: { type: String, required: true },
  status: { type: String, enum: ["present", "absent", "leave"], required: true },
  checkInAt: { type: Date, default: null },
  checkOutAt: { type: Date, default: null },
  reason: { type: String, required: true },
  adjustedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  history: { type: [historySchema], default: [] },
}, { timestamps: true });

attendanceAdjustmentSchema.index({ organizationId: 1, employeeId: 1, attendanceDate: 1 }, { unique: true });
attendanceAdjustmentSchema.index({ organizationId: 1, attendanceDate: 1 });

export const AttendanceAdjustmentModel = model("AttendanceAdjustment", attendanceAdjustmentSchema);
