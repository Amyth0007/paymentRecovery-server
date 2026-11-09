import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const officeLocationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(400),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(20).max(5000),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const attendancePolicySchema = z.object({
  expectedCheckIn: timeSchema,
  expectedCheckOut: timeSchema,
  gracePeriodMinutes: z.number().int().min(0).max(240),
  halfDayHours: z.number().min(1).max(12),
  gpsAccuracyThresholdM: z.number().int().min(5).max(500),
  locationVerificationRequired: z.boolean(),
  weeklyHolidays: z.array(z.number().int().min(0).max(6)).max(7),
  correctionRequestsEnabled: z.boolean(),
});

export const attendancePunchSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  gpsAccuracyM: z.number().finite().positive().max(10000).optional(),
  photoAssetId: objectIdSchema,
}).refine((value) => [value.latitude, value.longitude, value.gpsAccuracyM].every((part) => part === undefined) || [value.latitude, value.longitude, value.gpsAccuracyM].every((part) => part !== undefined), "Provide all location values or none");

export const attendanceListQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  employeeId: objectIdSchema.optional(),
  officeLocationId: objectIdSchema.optional(),
  status: z.enum(["checked_in", "completed", "present", "absent", "leave"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const attendanceAdjustmentSchema = z.object({
  employeeId: objectIdSchema,
  attendanceDate: dateSchema,
  status: z.enum(["present", "absent", "leave"]),
  checkInAt: z.iso.datetime({ offset: true }).optional(),
  checkOutAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().trim().min(3).max(1000),
}).refine((value) => value.status !== "present" || Boolean(value.checkInAt), { message: "A check-in time is required for present attendance", path: ["checkInAt"] });

export const correctionCreateSchema = z.object({
  attendanceRecordId: objectIdSchema,
  requestedCheckOutAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(3).max(1000),
  evidenceFileAssetId: objectIdSchema.optional(),
});

export const correctionReviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(1000).default(""),
});

export const correctionListQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
