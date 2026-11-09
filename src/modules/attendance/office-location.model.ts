import { Schema, model } from "mongoose";

const officeLocationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  address: { type: String, required: true, trim: true, maxlength: 400 },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  geofenceRadiusM: { type: Number, required: true, min: 20, max: 5000 },
  status: { type: String, enum: ["active", "inactive"], default: "active", required: true },
}, { timestamps: true });

officeLocationSchema.index({ organizationId: 1, status: 1, name: 1 });
export const OfficeLocationModel = model("OfficeLocation", officeLocationSchema);
