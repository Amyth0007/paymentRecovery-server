import { Schema, model } from "mongoose";

const breakSchema = new Schema({ name: { type: String, required: true, trim: true }, startTime: { type: String, required: true }, endTime: { type: String, required: true }, paid: { type: Boolean, required: true, default: false } }, { _id: false });
const shiftSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true },
  shiftType: { type: String, enum: ["fixed", "rotational", "night", "flexible", "split"], required: true },
  startTime: { type: String, required: true }, endTime: { type: String, required: true },
  crossesMidnight: { type: Boolean, required: true, default: false },
  flexibleWindowMinutes: { type: Number, default: 0, min: 0, max: 720 },
  breaks: { type: [breakSchema], default: [] },
  weeklyOffs: { type: [Number], default: [], validate: (days: number[]) => days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) },
  effectiveFrom: { type: String, required: true }, effectiveTo: { type: String, default: null },
  status: { type: String, enum: ["active", "inactive"], required: true, default: "active" },
}, { timestamps: true });
shiftSchema.index({ organizationId: 1, name: 1, effectiveFrom: 1 }, { unique: true });
shiftSchema.index({ organizationId: 1, status: 1, effectiveFrom: 1 });
export const ShiftModel = model("WorkforceShift", shiftSchema);
