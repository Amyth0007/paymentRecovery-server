import type { AuthContext } from "../../common/auth/auth-context.js";
import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { FileAssetModel } from "../files/file-asset.model.js";
import { UserModel } from "../users/user.model.js";
import { AttendanceCorrectionModel } from "./attendance-correction.model.js";
import { AttendanceAdjustmentModel } from "./attendance-adjustment.model.js";
import { AttendancePolicyModel } from "./attendance-policy.model.js";
import { AttendanceRecordModel } from "./attendance-record.model.js";
import { OfficeLocationModel } from "./office-location.model.js";
import { evaluateGeofence, haversineMeters } from "./geofence.js";
import type {
  attendanceListQuerySchema,
  attendancePolicySchema,
  attendancePunchSchema,
  correctionCreateSchema,
  correctionListQuerySchema,
  correctionReviewSchema,
  officeLocationSchema,
} from "./attendance.schemas.js";
import type { z } from "zod";

type LocationInput = z.infer<typeof officeLocationSchema>;
type PolicyInput = z.infer<typeof attendancePolicySchema>;
type PunchInput = z.infer<typeof attendancePunchSchema>;
type RecordQuery = z.infer<typeof attendanceListQuerySchema>;
type CorrectionInput = z.infer<typeof correctionCreateSchema>;
type CorrectionQuery = z.infer<typeof correctionListQuerySchema>;
type CorrectionReview = z.infer<typeof correctionReviewSchema>;
type AdjustmentInput = z.infer<typeof import("./attendance.schemas.js").attendanceAdjustmentSchema>;

function dateForTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function minuteOfDay(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((item) => item.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((item) => item.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function policyView(policy: {
  expectedCheckIn: string;
  expectedCheckOut: string;
  gracePeriodMinutes: number;
  halfDayHours: number;
  gpsAccuracyThresholdM: number;
  weeklyHolidays: number[];
  correctionRequestsEnabled: boolean;
  locationVerificationRequired: boolean;
}) {
  return {
    expectedCheckIn: policy.expectedCheckIn,
    expectedCheckOut: policy.expectedCheckOut,
    gracePeriodMinutes: policy.gracePeriodMinutes,
    halfDayHours: policy.halfDayHours,
    gpsAccuracyThresholdM: policy.gpsAccuracyThresholdM,
    weeklyHolidays: policy.weeklyHolidays,
    correctionRequestsEnabled: policy.correctionRequestsEnabled,
    locationVerificationRequired: policy.locationVerificationRequired,
  };
}

export async function getAttendanceConfig(organizationId: string) {
  const policy = await AttendancePolicyModel.findOneAndUpdate(
    { organizationId },
    { $setOnInsert: { organizationId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const locations = await OfficeLocationModel.find({ organizationId }).sort({ name: 1 });
  return {
    policy: policyView(policy),
    locations: locations.map((location) => ({
      id: location._id.toString(), name: location.name, address: location.address,
      latitude: location.latitude, longitude: location.longitude,
      geofenceRadiusM: location.geofenceRadiusM, status: location.status,
    })),
  };
}

export async function updateAttendancePolicy(
  actor: AuthContext, organizationId: string, input: PolicyInput, meta: RequestMeta,
) {
  const policy = await AttendancePolicyModel.findOneAndUpdate(
    { organizationId }, { $set: input, $setOnInsert: { organizationId } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  await recordAudit({ actor, action: "attendance.policy_updated", entityType: "attendance_policy", entityId: policy._id.toString(), organizationId, after: policyView(policy), meta });
  return policyView(policy);
}

export async function createOfficeLocation(actor: AuthContext, organizationId: string, input: LocationInput, meta: RequestMeta) {
  const location = await OfficeLocationModel.create({ ...input, organizationId });
  await recordAudit({ actor, action: "attendance.office_created", entityType: "office_location", entityId: location._id.toString(), organizationId, after: input, meta });
  return { id: location._id.toString(), ...input };
}

export async function updateOfficeLocation(actor: AuthContext, organizationId: string, locationId: string, input: LocationInput, meta: RequestMeta) {
  const location = await OfficeLocationModel.findOne({ _id: locationId, organizationId });
  if (!location) throw new AppError("NOT_FOUND", "Office location not found", 404);
  const before = { name: location.name, address: location.address, latitude: location.latitude, longitude: location.longitude, geofenceRadiusM: location.geofenceRadiusM, status: location.status };
  Object.assign(location, input);
  await location.save();
  await recordAudit({ actor, action: "attendance.office_updated", entityType: "office_location", entityId: location._id.toString(), organizationId, before, after: input, meta });
  return { id: location._id.toString(), ...input };
}

export async function deleteOfficeLocation(actor: AuthContext, organizationId: string, locationId: string, meta: RequestMeta) {
  const location = await OfficeLocationModel.findOne({ _id: locationId, organizationId, status: "active" });
  if (!location) throw new AppError("NOT_FOUND", "Active office location not found", 404);
  location.status = "inactive";
  await location.save();
  await recordAudit({ actor, action: "attendance.office_deleted", entityType: "office_location", entityId: location._id.toString(), organizationId, before: { status: "active", name: location.name }, after: { status: "inactive" }, meta });
  return { id: location._id.toString(), status: location.status };
}

type VerifiedPunch = {
  at: Date;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracyM?: number | null;
  officeDistanceM?: number | null;
  locationVerification: "verified" | "not_enforced";
  photoAssetId: Types.ObjectId;
};

async function validatePunch(
  actor: AuthContext,
  organizationId: string,
  input: PunchInput,
  officeLocationId: string,
  timestamp: Date,
): Promise<{ office: Awaited<ReturnType<typeof OfficeLocationModel.findOne>>; punch: VerifiedPunch }> {
  const [office, policy, photo] = await Promise.all([
    officeLocationId ? OfficeLocationModel.findOne({ _id: officeLocationId, organizationId, status: "active" }) : Promise.resolve(null),
    AttendancePolicyModel.findOne({ organizationId }),
    FileAssetModel.findOne({ _id: input.photoAssetId, organizationId, purpose: "attendance_photo", uploadedBy: actor.userId }),
  ]);
  if (!photo) throw new AppError("NOT_FOUND", "Attendance photo not found for this employee", 404);
  const strict = policy?.locationVerificationRequired !== false;
  if (strict && !office) throw new AppError("NOT_FOUND", "Select an active office location", 404);
  const hasLocation = input.latitude !== undefined && input.longitude !== undefined && input.gpsAccuracyM !== undefined;
  if (strict && !hasLocation) throw new AppError("LOCATION_REQUIRED", "Device location is required by your organization", 422);
  let distance: number | null = null;
  if (strict && office && hasLocation) {
  const accuracyLimit = policy?.gpsAccuracyThresholdM ?? 50;
  distance = haversineMeters(input.latitude!, input.longitude!, office.latitude, office.longitude);
  const geofenceResult = evaluateGeofence(distance, input.gpsAccuracyM!, office.geofenceRadiusM, accuracyLimit);
  if (geofenceResult === "low_accuracy") {
    throw new AppError("LOCATION_ACCURACY_LOW", `GPS accuracy is too low. Retry when it is ${accuracyLimit} meters or better.`, 422);
  }
  if (geofenceResult === "outside") {
    throw new AppError("OUTSIDE_GEOFENCE", "You appear to be outside the selected office geofence", 422, { distanceM: Math.round(distance), radiusM: office.geofenceRadiusM });
  }
  if (geofenceResult === "ambiguous") {
    throw new AppError("LOCATION_AMBIGUOUS", "GPS uncertainty overlaps the geofence boundary. Retry for a more accurate location or ask an administrator to review.", 422, { distanceM: Math.round(distance), accuracyM: Math.round(input.gpsAccuracyM!), radiusM: office.geofenceRadiusM });
  }
  }
  return {
    office,
    punch: {
      at: timestamp,
      latitude: hasLocation ? input.latitude! : null,
      longitude: hasLocation ? input.longitude! : null,
      gpsAccuracyM: hasLocation ? input.gpsAccuracyM! : null,
      officeDistanceM: distance === null ? null : Math.round(distance),
      locationVerification: strict ? "verified" : "not_enforced",
      photoAssetId: new Types.ObjectId(input.photoAssetId),
    },
  };
}

export async function checkIn(actor: AuthContext, organizationId: string, input: PunchInput & { officeLocationId?: string }, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const date = dateForTimezone(new Date(), organization.timezone);
  const existing = await AttendanceRecordModel.findOne({ organizationId, employeeId: actor.userId, attendanceDate: date });
  if (existing) throw new AppError("INVALID_STATE", existing.status === "checked_in" ? "You are already checked in" : "Attendance is already complete for today", 409);
  const timestamp = new Date();
  if (await AttendanceAdjustmentModel.exists({ organizationId, employeeId: actor.userId, attendanceDate: date })) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for today", 409);
  const { office, punch } = await validatePunch(actor, organizationId, input, input.officeLocationId ?? "", timestamp);
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  const [expectedHour, expectedMinute] = (policy?.expectedCheckIn ?? "09:00").split(":").map(Number);
  const lateArrival = minuteOfDay(timestamp, organization.timezone) > expectedHour * 60 + expectedMinute + (policy?.gracePeriodMinutes ?? 10);
  try {
    const record = await AttendanceRecordModel.create({ organizationId, employeeId: actor.userId, attendanceDate: date, officeLocationId: office?._id ?? null, checkIn: punch, status: "checked_in", lateArrival });
    await recordAudit({ actor, action: "attendance.checked_in", entityType: "attendance", entityId: record._id.toString(), organizationId, after: { attendanceDate: date, officeLocationId: office?._id.toString() ?? null, officeDistanceM: punch.officeDistanceM, gpsAccuracyM: punch.gpsAccuracyM, photoAssetId: punch.photoAssetId, lateArrival }, meta });
    return presentRecord(record);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("INVALID_STATE", "Attendance is already recorded for today", 409);
    throw error;
  }
}

export async function checkOut(actor: AuthContext, organizationId: string, input: PunchInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const date = dateForTimezone(new Date(), organization.timezone);
  if (await AttendanceAdjustmentModel.exists({ organizationId, employeeId: actor.userId, attendanceDate: date })) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for today", 409);
  const record = await AttendanceRecordModel.findOne({ organizationId, employeeId: actor.userId, attendanceDate: date, status: "checked_in" });
  if (!record || !record.checkIn) throw new AppError("INVALID_STATE", "You do not have an open check-in for today", 409);
  const timestamp = new Date();
  if (timestamp <= record.checkIn.at) throw new AppError("INVALID_STATE", "Check-out time must be after check-in", 422);
  const { punch } = await validatePunch(actor, organizationId, input, record.officeLocationId?.toString() ?? "", timestamp);
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  record.checkOut = punch;
  record.status = "completed";
  record.totalWorkingMinutes = Math.floor((timestamp.getTime() - record.checkIn.at.getTime()) / 60_000);
  record.halfDay = record.totalWorkingMinutes < (policy?.halfDayHours ?? 4) * 60;
  await record.save();
  await recordAudit({ actor, action: "attendance.checked_out", entityType: "attendance", entityId: record._id.toString(), organizationId, after: { attendanceDate: date, totalWorkingMinutes: record.totalWorkingMinutes, photoAssetId: punch.photoAssetId, officeDistanceM: punch.officeDistanceM, gpsAccuracyM: punch.gpsAccuracyM }, meta });
  return presentRecord(record);
}

function presentRecord(record: {
  _id: { toString(): string };
  employeeId: { toString(): string };
  attendanceDate: string;
  officeLocationId?: { toString(): string } | null;
  checkIn?: VerifiedPunch | null;
  checkOut?: VerifiedPunch | null;
  correctedCheckOutAt?: Date | null;
  correctionId?: { toString(): string } | null;
  status: string;
  lateArrival: boolean;
  totalWorkingMinutes?: number | null;
  halfDay: boolean;
}) {
  return {
    id: record._id.toString(), employeeId: record.employeeId.toString(), attendanceDate: record.attendanceDate,
    officeLocationId: record.officeLocationId?.toString() ?? null, checkIn: record.checkIn ?? null,
    checkOut: record.checkOut ?? null, correctedCheckOutAt: record.correctedCheckOutAt ?? null,
    correctionId: record.correctionId?.toString() ?? null, status: record.status,
    lateArrival: record.lateArrival, totalWorkingMinutes: record.totalWorkingMinutes ?? null, halfDay: record.halfDay,
  };
}

export async function listAttendanceRecords(actor: AuthContext, organizationId: string, query: RecordQuery) {
  const isAdmin = actor.role === "org_admin" || actor.role === "accounts_manager";
  const employeeId = isAdmin ? (query.employeeId ?? undefined) : actor.userId;
  const filter: Record<string, unknown> = { organizationId, ...(employeeId ? { employeeId } : {}) };
  if (query.from || query.to) filter.attendanceDate = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  const [records, adjustments] = await Promise.all([
    AttendanceRecordModel.find(filter).sort({ attendanceDate: -1, createdAt: -1 }),
    AttendanceAdjustmentModel.find({ organizationId, ...(employeeId ? { employeeId } : {}), ...(filter.attendanceDate ? { attendanceDate: filter.attendanceDate } : {}) }),
  ]);
  const adjustmentMap = new Map(adjustments.map((item) => [`${item.employeeId.toString()}:${item.attendanceDate}`, item]));
  const recordKeys = new Set(records.map((item) => `${item.employeeId.toString()}:${item.attendanceDate}`));
  const combined: Array<Record<string, any>> = records.map((record) => {
    const base = presentRecord(record);
    const adjustment = adjustmentMap.get(`${record.employeeId.toString()}:${record.attendanceDate}`);
    return adjustment ? { ...base, status: adjustment.status, manualAdjustment: { id: adjustment._id.toString(), reason: adjustment.reason, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, adjustedBy: adjustment.adjustedBy.toString() }, checkIn: adjustment.status === "present" && adjustment.checkInAt ? { ...(base.checkIn ?? {}), at: adjustment.checkInAt, photoAssetId: base.checkIn?.photoAssetId ?? null, manuallyEntered: true } : base.checkIn, checkOut: adjustment.status === "present" && adjustment.checkOutAt ? { ...(base.checkOut ?? {}), at: adjustment.checkOutAt, photoAssetId: base.checkOut?.photoAssetId ?? null, manuallyEntered: true } : base.checkOut } : base;
  });
  for (const adjustment of adjustments) if (!recordKeys.has(`${adjustment.employeeId.toString()}:${adjustment.attendanceDate}`)) combined.push({ id: `adjustment-${adjustment._id}`, employeeId: adjustment.employeeId.toString(), attendanceDate: adjustment.attendanceDate, officeLocationId: null, checkIn: adjustment.status === "present" && adjustment.checkInAt ? { at: adjustment.checkInAt, photoAssetId: null, manuallyEntered: true } : null, checkOut: adjustment.status === "present" && adjustment.checkOutAt ? { at: adjustment.checkOutAt, photoAssetId: null, manuallyEntered: true } : null, status: adjustment.status, lateArrival: false, totalWorkingMinutes: adjustment.checkInAt && adjustment.checkOutAt ? Math.floor((adjustment.checkOutAt.getTime() - adjustment.checkInAt.getTime()) / 60_000) : null, halfDay: false, manualAdjustment: { id: adjustment._id.toString(), reason: adjustment.reason, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, adjustedBy: adjustment.adjustedBy.toString() } });
  const filtered = combined.filter((record) => (!query.officeLocationId || record.officeLocationId === query.officeLocationId) && (!query.status || record.status === query.status || (query.status === "present" && record.status === "completed") || (query.status === "completed" && record.status === "present"))).sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  const total = filtered.length;
  const skip = (query.page - 1) * query.limit;
  const pageItems = filtered.slice(skip, skip + query.limit);
  const employeeIds = [...new Set(pageItems.map((record) => record.employeeId))];
  const officeIds = [...new Set(pageItems.map((record) => record.officeLocationId).filter(Boolean))];
  const [employees, offices] = await Promise.all([
    UserModel.find({ _id: { $in: employeeIds }, organizationId }).select("name email"),
    OfficeLocationModel.find({ _id: { $in: officeIds }, organizationId }).select("name"),
  ]);
  const employeeNames = new Map(employees.map((employee) => [employee._id.toString(), { name: employee.name, email: employee.email }]));
  const officeNames = new Map(offices.map((office) => [office._id.toString(), office.name]));
  return {
    items: pageItems.map((record) => ({ ...record, employee: employeeNames.get(record.employeeId) ?? null, officeName: record.officeLocationId ? officeNames.get(record.officeLocationId) ?? "Office" : "—" })),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function attendanceDashboard(organizationId: string, date?: string) {
  const organization = await assertTenantAccessible(organizationId);
  const attendanceDate = date ?? dateForTimezone(new Date(), organization.timezone);
  const weekday = new Date(`${attendanceDate}T12:00:00.000Z`).getUTCDay();
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  const holiday = policy?.weeklyHolidays.includes(weekday) ?? weekday === 0;
  const [totalEmployees, records, pendingCorrections] = await Promise.all([
    UserModel.countDocuments({ organizationId, status: "active", role: { $in: ["org_admin", "accounts_manager", "field_recovery", "employee"] } }),
    AttendanceRecordModel.find({ organizationId, attendanceDate }),
    AttendanceCorrectionModel.countDocuments({ organizationId, status: "pending" }),
  ]);
  const adjustments = await AttendanceAdjustmentModel.find({ organizationId, attendanceDate });
  const adjusted = new Map(adjustments.map((item) => [item.employeeId.toString(), item]));
  const present = new Set(records.map((record) => record.employeeId.toString()).filter((id) => adjusted.get(id)?.status !== "absent" && adjusted.get(id)?.status !== "leave"));
  for (const item of adjustments) if (item.status === "present") present.add(item.employeeId.toString());
  const onLeave = adjustments.filter((item) => item.status === "leave").length;
  return {
    date: attendanceDate,
    totalEmployees,
    presentToday: present.size,
    onLeaveToday: onLeave,
    absentToday: holiday ? 0 : Math.max(0, totalEmployees - present.size - onLeave),
    lateArrivals: records.filter((record) => record.lateArrival).length,
    currentlyCheckedIn: records.filter((record) => record.status === "checked_in").length,
    exceptions: pendingCorrections,
    holiday,
  };
}

export async function upsertAttendanceAdjustment(actor: AuthContext, organizationId: string, input: AdjustmentInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  if (input.attendanceDate > dateForTimezone(new Date(), organization.timezone)) throw new AppError("VALIDATION_ERROR", "Attendance cannot be set for a future date", 422);
  const employee = await UserModel.findOne({ _id: input.employeeId, organizationId, status: "active", role: { $in: ["employee", "field_recovery", "accounts_manager", "org_admin"] } });
  if (!employee) throw new AppError("NOT_FOUND", "Active organization employee not found", 404);
  const checkInAt = input.checkInAt ? new Date(input.checkInAt) : null;
  const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;
  if (input.status === "present") {
    if (!checkInAt || checkInAt > new Date()) throw new AppError("VALIDATION_ERROR", "Present attendance requires a check-in time that is not in the future", 422);
    if (checkOutAt && (checkOutAt <= checkInAt || checkOutAt > new Date())) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in and not in the future", 422);
  } else if (checkInAt || checkOutAt) throw new AppError("VALIDATION_ERROR", "Check-in/out times apply only to present attendance", 422);

  const after = { status: input.status, checkInAt, checkOutAt, reason: input.reason };
  let adjustment = await AttendanceAdjustmentModel.findOne({ organizationId, employeeId: employee._id, attendanceDate: input.attendanceDate });
  const before = adjustment ? { status: adjustment.status, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, reason: adjustment.reason } : null;
  if (!adjustment) adjustment = new AttendanceAdjustmentModel({ organizationId, employeeId: employee._id, attendanceDate: input.attendanceDate, adjustedBy: actor.userId, history: [] });
  Object.assign(adjustment, after, { adjustedBy: actor.userId });
  adjustment.history.push({ before, after, actorId: actor.userId, at: new Date() });
  await adjustment.save();
  await recordAudit({ actor, action: "attendance.manually_adjusted", entityType: "attendance_adjustment", entityId: adjustment._id.toString(), organizationId, before, after: { ...after, employeeId: employee._id.toString(), attendanceDate: input.attendanceDate }, reason: input.reason, meta });
  return { id: adjustment._id.toString(), employeeId: employee._id.toString(), employee: { name: employee.name, email: employee.email }, attendanceDate: adjustment.attendanceDate, ...after, adjustedBy: actor.userId };
}

export async function createCorrectionRequest(actor: AuthContext, organizationId: string, input: CorrectionInput, meta: RequestMeta) {
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  if (policy?.correctionRequestsEnabled === false) throw new AppError("FEATURE_DISABLED", "Attendance correction requests are disabled", 403);
  const record = await AttendanceRecordModel.findOne({ _id: input.attendanceRecordId, organizationId, employeeId: actor.userId });
  if (!record?.checkIn) throw new AppError("NOT_FOUND", "Your attendance record was not found", 404);
  if (record.checkOut || record.correctedCheckOutAt) throw new AppError("INVALID_STATE", "This attendance record already has a check-out", 409);
  const requestedCheckOutAt = new Date(input.requestedCheckOutAt);
  if (requestedCheckOutAt <= record.checkIn.at || requestedCheckOutAt > new Date()) throw new AppError("VALIDATION_ERROR", "Requested check-out must be after check-in and not in the future", 422);
  const evidence = input.evidenceFileAssetId
    ? await FileAssetModel.findOne({ _id: input.evidenceFileAssetId, organizationId, uploadedBy: actor.userId })
    : null;
  if (input.evidenceFileAssetId && !evidence) throw new AppError("NOT_FOUND", "Correction evidence was not found", 404);
  const existing = await AttendanceCorrectionModel.findOne({ organizationId, attendanceRecordId: record._id, status: "pending" });
  if (existing) throw new AppError("CONFLICT", "A correction request is already pending for this attendance", 409);
  const correction = await AttendanceCorrectionModel.create({ organizationId, attendanceRecordId: record._id, employeeId: actor.userId, requestedCheckOutAt, reason: input.reason, evidenceFileAssetId: evidence?._id ?? null });
  await recordAudit({ actor, action: "attendance.correction_requested", entityType: "attendance_correction", entityId: correction._id.toString(), organizationId, after: { attendanceRecordId: record._id.toString(), requestedCheckOutAt, reason: input.reason }, meta });
  return presentCorrection(correction);
}

function presentCorrection(correction: {
  _id: { toString(): string }; attendanceRecordId: { toString(): string }; employeeId: { toString(): string };
  requestedCheckOutAt: Date; reason: string; evidenceFileAssetId?: { toString(): string } | null;
  status: string; reviewedBy?: { toString(): string } | null; reviewedAt?: Date | null;
  reviewComment?: string; createdAt: Date;
}) {
  return { id: correction._id.toString(), attendanceRecordId: correction.attendanceRecordId.toString(), employeeId: correction.employeeId.toString(), requestedCheckOutAt: correction.requestedCheckOutAt, reason: correction.reason, evidenceFileAssetId: correction.evidenceFileAssetId?.toString() ?? null, status: correction.status, reviewedBy: correction.reviewedBy?.toString() ?? null, reviewedAt: correction.reviewedAt ?? null, reviewComment: correction.reviewComment ?? "", createdAt: correction.createdAt };
}

export async function listCorrections(organizationId: string, query: CorrectionQuery) {
  const filter = { organizationId, ...(query.status ? { status: query.status } : {}) };
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    AttendanceCorrectionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AttendanceCorrectionModel.countDocuments(filter),
  ]);
  const employeeIds = [...new Set(corrections.map((correction) => correction.employeeId.toString()))];
  const employees = await UserModel.find({ _id: { $in: employeeIds }, organizationId }).select("name email");
  const employeeMap = new Map(employees.map((employee) => [employee._id.toString(), { name: employee.name, email: employee.email }]));
  return { items: corrections.map((correction) => ({ ...presentCorrection(correction), employee: employeeMap.get(correction.employeeId.toString()) ?? null })), meta: { page: query.page, limit: query.limit, total } };
}

export async function listEmployeeCorrections(actor: AuthContext, organizationId: string, query: CorrectionQuery) {
  const filter = { organizationId, employeeId: actor.userId, ...(query.status ? { status: query.status } : {}) };
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    AttendanceCorrectionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AttendanceCorrectionModel.countDocuments(filter),
  ]);
  return { items: corrections.map(presentCorrection), meta: { page: query.page, limit: query.limit, total } };
}

export async function reviewCorrection(actor: AuthContext, organizationId: string, correctionId: string, input: CorrectionReview, meta: RequestMeta) {
  const correction = await AttendanceCorrectionModel.findOne({ _id: correctionId, organizationId, status: "pending" });
  if (!correction) throw new AppError("NOT_FOUND", "Pending correction request not found", 404);
  const record = await AttendanceRecordModel.findOne({ _id: correction.attendanceRecordId, organizationId, employeeId: correction.employeeId });
  if (!record?.checkIn || record.checkOut || record.correctedCheckOutAt) throw new AppError("INVALID_STATE", "Attendance record cannot accept this correction", 409);
  const before = { status: record.status, checkOutAt: null, correctedCheckOutAt: record.correctedCheckOutAt ?? null };
  correction.status = input.decision;
  correction.reviewedBy = new Types.ObjectId(actor.userId);
  correction.reviewedAt = new Date();
  correction.reviewComment = input.comment;
  if (input.decision === "approved") {
    const policy = await AttendancePolicyModel.findOne({ organizationId });
    const checkOutAt = correction.requestedCheckOutAt;
    record.correctedCheckOutAt = checkOutAt;
    record.correctionId = correction._id;
    record.status = "completed";
    record.totalWorkingMinutes = Math.floor((checkOutAt.getTime() - record.checkIn.at.getTime()) / 60_000);
    record.halfDay = record.totalWorkingMinutes < (policy?.halfDayHours ?? 4) * 60;
    correction.appliedChange = { field: "checkOutAt", before: null, after: checkOutAt, approvedBy: actor.userId, reason: correction.reason };
    await record.save();
  }
  await correction.save();
  await recordAudit({ actor, action: `attendance.correction_${input.decision}`, entityType: "attendance_correction", entityId: correction._id.toString(), organizationId, before, after: { status: record.status, correctionStatus: correction.status, requestedCheckOutAt: correction.requestedCheckOutAt, reviewComment: correction.reviewComment }, reason: input.comment || correction.reason, meta });
  return presentCorrection(correction);
}
