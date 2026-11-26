import type { AuthContext } from "../../common/auth/auth-context.js";
import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { FileAssetModel } from "../files/file-asset.model.js";
import { UserModel } from "../users/user.model.js";
import { effectiveUserAccess } from "../users/user-access.service.js";
import { AttendanceCorrectionModel } from "./attendance-correction.model.js";
import { AttendanceAdjustmentModel } from "./attendance-adjustment.model.js";
import { AttendancePolicyModel } from "./attendance-policy.model.js";
import { AttendanceRecordModel } from "./attendance-record.model.js";
import { OfficeLocationModel } from "./office-location.model.js";
import { evaluateGeofence, haversineMeters } from "./geofence.js";
import { previousDay, shouldUsePreviousOvernightWorkday } from "./workday.js";
import { calculateScheduledShiftMinutes, calculateWorkingMinutes } from "./break-calculator.js";
import { getEffectiveShiftForDate } from "./effective-shift.js";
import { WorkforceEmployeeModel } from "../workforce/employee.model.js";
import { LeaveRequestModel } from "../workforce/leave.model.js";
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
type GuardPunchInput = z.infer<typeof import("./attendance.schemas.js").guardPunchSchema>;

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

export async function getAttendanceConfig(actorOrOrgId: AuthContext | string, possibleOrgId?: string) {
  const organizationId = typeof actorOrOrgId === "string" ? actorOrOrgId : possibleOrgId!;
  const actor = typeof actorOrOrgId === "string" ? null : actorOrOrgId;
  const organization = await assertTenantAccessible(organizationId);
  const policy = await AttendancePolicyModel.findOneAndUpdate(
    { organizationId },
    { $setOnInsert: { organizationId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const locations = await OfficeLocationModel.find({ organizationId }).sort({ name: 1 });

  let todayShift = null;
  if (actor) {
    const today = dateForTimezone(new Date(), organization.timezone);
    const profile = await WorkforceEmployeeModel.findOne({ organizationId, userId: actor.userId, status: "active" }).select("_id");
    const assignedShift: any = profile ? await getEffectiveShiftForDate(organizationId, profile._id, today) : null;
    if (assignedShift) {
      const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
      const isWeeklyOff = assignedShift.weeklyOffs?.includes(weekday) ?? false;
      todayShift = {
        id: assignedShift._id.toString(),
        name: assignedShift.name,
        shiftType: assignedShift.shiftType,
        startTime: assignedShift.startTime,
        endTime: assignedShift.endTime,
        crossesMidnight: Boolean(assignedShift.crossesMidnight),
        flexibleWindowMinutes: assignedShift.flexibleWindowMinutes ?? 0,
        breaks: (assignedShift.breaks ?? []).map((brk: any) => ({
          name: brk.name,
          startTime: brk.startTime,
          endTime: brk.endTime,
          paid: Boolean(brk.paid),
        })),
        weeklyOffs: assignedShift.weeklyOffs ?? [],
        isWeeklyOff,
      };
    }
  }

  return {
    policy: policyView(policy),
    locations: locations.map((location) => ({
      id: location._id.toString(), name: location.name, address: location.address,
      latitude: location.latitude, longitude: location.longitude,
      geofenceRadiusM: location.geofenceRadiusM, status: location.status,
    })),
    todayShift,
  };
}

export async function listAttendanceEmployees(organizationId: string) {
  const linkedUserIds = await WorkforceEmployeeModel.distinct("userId", { organizationId, userId: { $ne: null } });
  const [profiles, users] = await Promise.all([
    WorkforceEmployeeModel.find({ organizationId, status: "active" }).populate("userId", "email").sort({ lastName: 1, firstName: 1 }).lean(),
    UserModel.find({ organizationId, status: "active", role: { $in: ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee", "guard"] }, _id: { $nin: linkedUserIds } }).select("name email").sort({ name: 1 }).lean(),
  ]);
  return [
    ...profiles.map((profile: any) => ({ id: profile.userId?._id?.toString() ?? profile._id.toString(), name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.userId?.email ?? profile.email ?? "", employeeNumber: profile.employeeNumber, profileId: profile._id.toString(), hasLogin: Boolean(profile.userId) })),
    ...users.map((user: any) => ({ id: user._id.toString(), name: user.name, email: user.email, employeeNumber: "", profileId: null, hasLogin: true })),
  ];
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
  const timestamp = new Date();
  const localDate = dateForTimezone(timestamp, organization.timezone);
  const localMinute = minuteOfDay(timestamp, organization.timezone);
  const profile = await WorkforceEmployeeModel.findOne({ organizationId, userId: actor.userId, status: "active" }).select("_id");
  const previousShift: any = profile ? await getEffectiveShiftForDate(organizationId, profile._id, previousDay(localDate)) : null;
  const previousShiftInfo = previousShift ? { crossesMidnight: Boolean(previousShift.crossesMidnight), endTime: previousShift.endTime } : null;
  const date = shouldUsePreviousOvernightWorkday(localMinute, previousShiftInfo) ? previousDay(localDate) : localDate;
  const openAttendance = await AttendanceRecordModel.findOne({ organizationId, employeeId: actor.userId, status: "checked_in" });
  if (openAttendance) throw new AppError("INVALID_STATE", "You already have an open attendance shift. Check out before starting another.", 409);
  const existing = await AttendanceRecordModel.findOne({ organizationId, employeeId: actor.userId, attendanceDate: date });
  if (existing) throw new AppError("INVALID_STATE", existing.status === "checked_in" ? "You are already checked in" : "Attendance is already complete for today", 409);
  if (await AttendanceAdjustmentModel.exists({ organizationId, employeeId: actor.userId, attendanceDate: date })) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for today", 409);
  const { office, punch } = await validatePunch(actor, organizationId, input, input.officeLocationId ?? "", timestamp);
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  const assignedShift: any = profile ? await getEffectiveShiftForDate(organizationId, profile._id, date) : null;
  const [expectedHour, expectedMinute] = (assignedShift?.startTime ?? policy?.expectedCheckIn ?? "09:00").split(":").map(Number);
  const graceMinutes = (policy?.gracePeriodMinutes ?? 10) + (assignedShift?.flexibleWindowMinutes ?? 0);
  const punchMinuteOnWorkday = localMinute + (date !== localDate ? 1440 : 0);
  const lateArrival = punchMinuteOnWorkday > expectedHour * 60 + expectedMinute + graceMinutes;
  try {
    const record = await AttendanceRecordModel.create({
      organizationId,
      employeeId: actor.userId,
      attendanceDate: date,
      officeLocationId: office?._id ?? null,
      shiftId: assignedShift?._id ?? null,
      shiftName: assignedShift?.name ?? null,
      checkIn: punch,
      status: "checked_in",
      lateArrival,
    });
    await recordAudit({
      actor,
      action: "attendance.checked_in",
      entityType: "attendance",
      entityId: record._id.toString(),
      organizationId,
      after: {
        attendanceDate: date,
        officeLocationId: office?._id.toString() ?? null,
        shiftId: assignedShift?._id?.toString() ?? null,
        officeDistanceM: punch.officeDistanceM,
        gpsAccuracyM: punch.gpsAccuracyM,
        photoAssetId: punch.photoAssetId,
        lateArrival,
      },
      meta,
    });
    return presentRecord(record);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("INVALID_STATE", "Attendance is already recorded for today", 409);
    throw error;
  }
}

export async function checkOut(actor: AuthContext, organizationId: string, input: PunchInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const record = await AttendanceRecordModel.findOne({ organizationId, employeeId: actor.userId, status: "checked_in" }).sort({ createdAt: -1 });
  if (!record || !record.checkIn) throw new AppError("INVALID_STATE", "You do not have an open check-in", 409);
  if (await AttendanceAdjustmentModel.exists({ organizationId, employeeId: actor.userId, attendanceDate: record.attendanceDate })) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for this shift", 409);
  const timestamp = new Date();
  if (timestamp <= record.checkIn.at) throw new AppError("INVALID_STATE", "Check-out time must be after check-in", 422);
  if (timestamp.getTime() - record.checkIn.at.getTime() > 36 * 60 * 60 * 1000) throw new AppError("INVALID_STATE", "This check-in is too old to check out. Submit an attendance correction request.", 409);
  const { punch } = await validatePunch(actor, organizationId, input, record.officeLocationId?.toString() ?? "", timestamp);
  const policy = await AttendancePolicyModel.findOne({ organizationId });

  const profile = await WorkforceEmployeeModel.findOne({ organizationId, userId: actor.userId, status: "active" }).select("_id");
  const assignedShift: any = profile ? await getEffectiveShiftForDate(organizationId, profile._id, record.attendanceDate) : null;
  const workingResult = calculateWorkingMinutes(record.checkIn.at, timestamp, assignedShift, record.attendanceDate, organization.timezone);

  record.checkOut = punch;
  record.status = "completed";
  record.totalWorkingMinutes = workingResult.totalWorkingMinutes;
  (record as any).unpaidBreakMinutes = workingResult.unpaidBreakMinutes;

  let halfDayThreshold = (policy?.halfDayHours ?? 4) * 60;
  if (assignedShift?.startTime && assignedShift?.endTime) {
    const scheduledMinutes = calculateScheduledShiftMinutes(assignedShift.startTime, assignedShift.endTime, Boolean(assignedShift.crossesMidnight));
    halfDayThreshold = Math.min(halfDayThreshold, Math.floor(scheduledMinutes / 2));
  }
  record.halfDay = record.totalWorkingMinutes < halfDayThreshold;

  await record.save();
  await recordAudit({
    actor,
    action: "attendance.checked_out",
    entityType: "attendance",
    entityId: record._id.toString(),
    organizationId,
    after: {
      attendanceDate: record.attendanceDate,
      totalWorkingMinutes: record.totalWorkingMinutes,
      unpaidBreakMinutes: (record as any).unpaidBreakMinutes,
      photoAssetId: punch.photoAssetId,
      officeDistanceM: punch.officeDistanceM,
      gpsAccuracyM: punch.gpsAccuracyM,
    },
    meta,
  });
  return presentRecord(record);
}

function presentRecord(record: {
  _id: { toString(): string };
  employeeId: { toString(): string };
  attendanceDate: string;
  officeLocationId?: { toString(): string } | null;
  shiftId?: { toString(): string } | null;
  shiftName?: string | null;
  checkIn?: VerifiedPunch | null;
  checkOut?: VerifiedPunch | null;
  correctedCheckOutAt?: Date | null;
  correctionId?: { toString(): string } | null;
  status: string;
  lateArrival: boolean;
  totalWorkingMinutes?: number | null;
  unpaidBreakMinutes?: number | null;
  halfDay: boolean;
}) {
  return {
    id: record._id.toString(),
    employeeId: record.employeeId.toString(),
    attendanceDate: record.attendanceDate,
    officeLocationId: record.officeLocationId?.toString() ?? null,
    shiftId: record.shiftId?.toString() ?? null,
    shiftName: record.shiftName ?? null,
    checkIn: record.checkIn ?? null,
    checkOut: record.checkOut ?? null,
    correctedCheckOutAt: record.correctedCheckOutAt ?? null,
    correctionId: record.correctionId?.toString() ?? null,
    status: record.status,
    lateArrival: record.lateArrival,
    totalWorkingMinutes: record.totalWorkingMinutes ?? null,
    unpaidBreakMinutes: record.unpaidBreakMinutes ?? 0,
    halfDay: record.halfDay,
  };
}

export async function listAttendanceRecords(actor: AuthContext, organizationId: string, query: RecordQuery) {
  const access = actor.role === "sub_admin" ? await effectiveUserAccess(actor.userId) : null;
  const isAdmin = actor.role === "org_admin" || actor.role === "accounts_manager" || (actor.role === "sub_admin" && Boolean(access?.actions.includes("attendance.view_all") || access?.actions.includes("attendance.adjust")));
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
    return adjustment ? { ...base, status: adjustment.status, halfDay: adjustment.status === "half_day", manualAdjustment: { id: adjustment._id.toString(), reason: adjustment.reason, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, adjustedBy: adjustment.adjustedBy.toString() }, checkIn: ["present", "half_day"].includes(adjustment.status) && adjustment.checkInAt ? { ...(base.checkIn ?? {}), at: adjustment.checkInAt, photoAssetId: base.checkIn?.photoAssetId ?? null, manuallyEntered: true } : base.checkIn, checkOut: ["present", "half_day"].includes(adjustment.status) && adjustment.checkOutAt ? { ...(base.checkOut ?? {}), at: adjustment.checkOutAt, photoAssetId: base.checkOut?.photoAssetId ?? null, manuallyEntered: true } : base.checkOut } : base;
  });
  for (const adjustment of adjustments) if (!recordKeys.has(`${adjustment.employeeId.toString()}:${adjustment.attendanceDate}`)) combined.push({ id: `adjustment-${adjustment._id}`, employeeId: adjustment.employeeId.toString(), attendanceDate: adjustment.attendanceDate, officeLocationId: adjustment.officeLocationId?.toString() ?? null, checkIn: ["present", "half_day"].includes(adjustment.status) && adjustment.checkInAt ? { at: adjustment.checkInAt, photoAssetId: null, manuallyEntered: true } : null, checkOut: ["present", "half_day"].includes(adjustment.status) && adjustment.checkOutAt ? { at: adjustment.checkOutAt, photoAssetId: null, manuallyEntered: true } : null, status: adjustment.status, lateArrival: false, totalWorkingMinutes: adjustment.checkInAt && adjustment.checkOutAt ? Math.floor((adjustment.checkOutAt.getTime() - adjustment.checkInAt.getTime()) / 60_000) : null, halfDay: adjustment.status === "half_day", manualAdjustment: { id: adjustment._id.toString(), reason: adjustment.reason, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, adjustedBy: adjustment.adjustedBy.toString() } });
  const dateRange = query.from || query.to ? { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } : undefined;
  const profiles = await WorkforceEmployeeModel.find({ organizationId, userId: employeeId ? new Types.ObjectId(employeeId) : { $ne: null } }).select("_id userId firstName lastName");
  const profileIds = profiles.map((profile) => profile._id);
  if (profileIds.length) {
    const lower = query.from ?? "0000-01-01"; const upper = query.to ?? "9999-12-31";
    const leaveRequests = await LeaveRequestModel.find({ organizationId, employeeId: { $in: profileIds }, status: "approved", startDate: { $lte: upper }, endDate: { $gte: lower } }).populate("leaveTypeId", "name paid");
    const profileById = new Map(profiles.map((profile) => [profile._id.toString(), profile]));
    for (const leave of leaveRequests as any[]) {
      const profile = profileById.get(leave.employeeId.toString());
      if (!profile?.userId) continue;
      const requestStart = new Date(`${leave.startDate}T12:00:00.000Z`); const requestEnd = new Date(`${leave.endDate}T12:00:00.000Z`);
      for (const day = new Date(requestStart); day <= requestEnd; day.setUTCDate(day.getUTCDate() + 1)) {
        const attendanceDate = day.toISOString().slice(0, 10);
        if ((dateRange && (attendanceDate < lower || attendanceDate > upper))) continue;
        const key = `${profile.userId.toString()}:${attendanceDate}`;
        if (recordKeys.has(key) || adjustmentMap.has(key)) continue;
        combined.push({ id: `leave-${leave._id}-${attendanceDate}`, employeeId: profile.userId.toString(), attendanceDate, officeLocationId: null, checkIn: null, checkOut: null, status: "leave", lateArrival: false, totalWorkingMinutes: null, halfDay: leave.days < Math.round((requestEnd.getTime() - requestStart.getTime()) / 86400000) + 1, leaveRequest: { id: leave._id.toString(), type: leave.leaveTypeId?.name ?? "Leave", paid: leave.leaveTypeId?.paid ?? false } });
      }
    }
  }
  const filtered = combined.filter((record) => (!query.officeLocationId || record.officeLocationId === query.officeLocationId) && (!query.status || record.status === query.status || (query.status === "present" && record.status === "completed") || (query.status === "completed" && record.status === "present"))).sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  const total = filtered.length;
  const skip = (query.page - 1) * query.limit;
  const pageItems = filtered.slice(skip, skip + query.limit);
  const employeeIds = [...new Set(pageItems.map((record) => record.employeeId))];
  const officeIds = [...new Set(pageItems.map((record) => record.officeLocationId).filter(Boolean))];
  const [employees, profileEmployees, offices] = await Promise.all([
    UserModel.find({ _id: { $in: employeeIds }, organizationId }).select("name email"),
    WorkforceEmployeeModel.find({ _id: { $in: employeeIds }, organizationId }).select("employeeNumber firstName lastName email"),
    OfficeLocationModel.find({ _id: { $in: officeIds }, organizationId }).select("name"),
  ]);
  const employeeNames = new Map(employees.map((employee) => [employee._id.toString(), { name: employee.name, email: employee.email }]));
  for (const employee of profileEmployees) employeeNames.set(employee._id.toString(), { name: `${employee.firstName} ${employee.lastName}`.trim(), email: employee.email });
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
  const [userCount, profileCount, records, pendingCorrections] = await Promise.all([
    UserModel.countDocuments({ organizationId, status: "active", role: { $in: ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee"] } }),
    WorkforceEmployeeModel.countDocuments({ organizationId, status: "active", userId: null }),
    AttendanceRecordModel.find({ organizationId, attendanceDate }),
    AttendanceCorrectionModel.countDocuments({ organizationId, status: "pending" }),
  ]);
  const adjustments = await AttendanceAdjustmentModel.find({ organizationId, attendanceDate });
  const adjusted = new Map(adjustments.map((item) => [item.employeeId.toString(), item]));
  const present = new Set(records.map((record) => record.employeeId.toString()).filter((id) => adjusted.get(id)?.status !== "absent" && adjusted.get(id)?.status !== "leave"));
  for (const item of adjustments) if (item.status === "present") present.add(item.employeeId.toString());
  const onLeave = adjustments.filter((item) => item.status === "leave").length;
  const totalEmployees = userCount + profileCount;
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
  const employee = await UserModel.findOne({ _id: input.employeeId, organizationId, status: "active", role: { $in: ["employee", "field_recovery", "accounts_manager", "sub_admin", "org_admin", "guard"] } });
  const profile = employee ? null : await WorkforceEmployeeModel.findOne({ _id: input.employeeId, organizationId, status: "active" });
  if (!employee && !profile) throw new AppError("NOT_FOUND", "Active organization employee profile not found", 404);
  const targetId = employee?._id ?? profile!._id;
  const checkInAt = input.checkInAt ? new Date(input.checkInAt) : null;
  const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;
  if (input.photoAssetId && !await FileAssetModel.exists({ _id: input.photoAssetId, organizationId, purpose: "attendance_photo", uploadedBy: actor.userId })) throw new AppError("NOT_FOUND", "Uploaded attendance photo not found", 404);
  if (input.status === "present" || input.status === "half_day") {
    if (input.status === "present" && !checkInAt) throw new AppError("VALIDATION_ERROR", "Present attendance requires a check-in time", 422);
    if (checkInAt && checkInAt > new Date()) throw new AppError("VALIDATION_ERROR", "Check-in time cannot be in the future", 422);
    if (checkOutAt && (!checkInAt || checkOutAt <= checkInAt || checkOutAt > new Date())) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in and not in the future", 422);
  } else if (checkInAt || checkOutAt) throw new AppError("VALIDATION_ERROR", "Check-in/out times apply only to present attendance", 422);

  const after = { status: input.status, checkInAt, checkOutAt, reason: input.reason };
  let adjustment = await AttendanceAdjustmentModel.findOne({ organizationId, employeeId: targetId, attendanceDate: input.attendanceDate });
  const before = adjustment ? { status: adjustment.status, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, reason: adjustment.reason } : null;
  if (!adjustment) adjustment = new AttendanceAdjustmentModel({ organizationId, employeeId: targetId, ...(profile ? { workforceEmployeeId: profile._id } : {}), attendanceDate: input.attendanceDate, adjustedBy: actor.userId, history: [] });
  Object.assign(adjustment, after, { adjustedBy: actor.userId });
  if (input.photoAssetId && !adjustment.photoAssetIds.some((id) => id.toString() === input.photoAssetId)) adjustment.photoAssetIds.push(new Types.ObjectId(input.photoAssetId));
  adjustment.history.push({ before, after, actorId: actor.userId, at: new Date() });
  await adjustment.save();
  const employeeName = employee?.name ?? `${profile!.firstName} ${profile!.lastName}`.trim();
  const employeeEmail = employee?.email ?? profile!.email;
  await recordAudit({ actor, action: "attendance.manually_adjusted", entityType: "attendance_adjustment", entityId: adjustment._id.toString(), organizationId, before, after: { ...after, employeeId: targetId.toString(), workforceEmployeeId: profile?._id.toString() ?? null, attendanceDate: input.attendanceDate }, reason: input.reason, meta });
  return { id: adjustment._id.toString(), employeeId: targetId.toString(), employee: { name: employeeName, email: employeeEmail }, attendanceDate: adjustment.attendanceDate, ...after, adjustedBy: actor.userId };
}

export async function recordGuardPunch(actor: AuthContext, organizationId: string, input: GuardPunchInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const { office, punch } = await validatePunch(actor, organizationId, input, input.officeLocationId ?? "", new Date());
  const profile: any = await WorkforceEmployeeModel.findOne({ organizationId, status: "active", $or: [{ _id: input.employeeId }, { userId: input.employeeId }] }).populate("userId", "email");
  const employee = profile?.userId?._id
    ? await UserModel.findOne({ _id: profile.userId._id, organizationId, status: "active" }).select("_id name email")
    : await UserModel.findOne({ _id: input.employeeId, organizationId, status: "active", role: { $in: ["employee", "field_recovery", "accounts_manager", "sub_admin", "org_admin", "guard"] } }).select("_id name email");
  if (!employee && !profile) throw new AppError("NOT_FOUND", "Active employee profile was not found", 404);
  const attendanceDate = dateForTimezone(new Date(), organization.timezone);
  const targetEmployeeId = employee?._id ?? profile?._id;
  const adjustmentFilter = profile
    ? { organizationId, attendanceDate, $or: [{ workforceEmployeeId: profile._id }, { employeeId: targetEmployeeId }] }
    : { organizationId, employeeId: targetEmployeeId, attendanceDate };
  const current = await AttendanceAdjustmentModel.findOne(adjustmentFilter);
  const now = new Date().toISOString();
  if (profile) {
    const checkInAt = input.action === "check_in" ? new Date(now) : current?.checkInAt ?? null;
    const checkOutAt = input.action === "check_out" ? new Date(now) : current?.checkOutAt ?? null;
    if (input.action === "check_in" && current?.checkInAt) throw new AppError("INVALID_STATE", "This employee already has a check-in recorded for today.", 409);
    if (input.action === "check_out" && !current?.checkInAt) throw new AppError("INVALID_STATE", "Record a check-in before checking this employee out.", 409);
    if (input.action === "check_out" && current?.checkOutAt) throw new AppError("INVALID_STATE", "This employee already has a check-out recorded for today.", 409);
    const reason = input.action === "check_in" ? "Mobile guard check-in" : "Mobile guard check-out";
    const before = current ? { status: current.status, checkInAt: current.checkInAt, checkOutAt: current.checkOutAt, reason: current.reason } : null;
    const adjustment: any = current ?? new AttendanceAdjustmentModel({ organizationId, employeeId: targetEmployeeId, workforceEmployeeId: profile._id, attendanceDate, adjustedBy: actor.userId, history: [] });
    const after = { status: "present", checkInAt, checkOutAt, reason };
    Object.assign(adjustment, after, { adjustedBy: actor.userId });
    if (!adjustment.photoAssetIds.some((id: Types.ObjectId) => id.toString() === input.photoAssetId)) adjustment.photoAssetIds.push(new Types.ObjectId(input.photoAssetId));
    adjustment.officeLocationId = office?._id ?? null;
    const location = { latitude: punch.latitude, longitude: punch.longitude, gpsAccuracyM: punch.gpsAccuracyM, officeDistanceM: punch.officeDistanceM, locationVerification: punch.locationVerification };
    if (input.action === "check_in") adjustment.checkInLocation = location;
    else adjustment.checkOutLocation = location;
    adjustment.history.push({ before, after, actorId: actor.userId, at: new Date() });
    await adjustment.save();
    await recordAudit({ actor, action: `attendance.guard_${input.action}`, entityType: "attendance_adjustment", entityId: adjustment._id.toString(), organizationId, before, after: { ...after, workforceEmployeeId: profile._id.toString(), attendanceDate }, meta });
    return { id: adjustment._id.toString(), employeeId: profile._id.toString(), employee: { name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.email }, attendanceDate, ...after, adjustedBy: actor.userId };
  }
  if (input.action === "check_in") {
    if (current?.checkInAt) throw new AppError("INVALID_STATE", "This employee already has a check-in recorded for today.", 409);
    const after = { status: "present", checkInAt: new Date(now), checkOutAt: null, reason: "Mobile guard check-in" };
    const adjustment: any = current ?? new AttendanceAdjustmentModel({ organizationId, employeeId: employee!._id, attendanceDate, adjustedBy: actor.userId, history: [] });
    Object.assign(adjustment, after, { officeLocationId: office?._id ?? null, checkInLocation: { latitude: punch.latitude, longitude: punch.longitude, gpsAccuracyM: punch.gpsAccuracyM, officeDistanceM: punch.officeDistanceM, locationVerification: punch.locationVerification }, adjustedBy: actor.userId });
    adjustment.photoAssetIds.push(new Types.ObjectId(input.photoAssetId)); adjustment.history.push({ before: current ? { status: current.status, checkInAt: current.checkInAt, checkOutAt: current.checkOutAt, reason: current.reason } : null, after, actorId: actor.userId, at: new Date() });
    await adjustment.save();
    await recordAudit({ actor, action: "attendance.guard_check_in", entityType: "attendance_adjustment", entityId: adjustment._id.toString(), organizationId, after: { attendanceDate, officeLocationId: office?._id?.toString() ?? null }, meta });
    return { id: adjustment._id.toString(), employeeId: employee!._id.toString(), employee: { name: employee!.name, email: employee!.email }, attendanceDate, ...after, adjustedBy: actor.userId };
  }
  if (!current?.checkInAt) throw new AppError("INVALID_STATE", "Record a check-in before checking this employee out.", 409);
  if (current.checkOutAt) throw new AppError("INVALID_STATE", "This employee already has a check-out recorded for today.", 409);
  const after = { status: "present", checkInAt: current.checkInAt, checkOutAt: new Date(now), reason: "Mobile guard check-out" };
  Object.assign(current, after, { officeLocationId: office?._id ?? current.officeLocationId ?? null, checkOutLocation: { latitude: punch.latitude, longitude: punch.longitude, gpsAccuracyM: punch.gpsAccuracyM, officeDistanceM: punch.officeDistanceM, locationVerification: punch.locationVerification }, adjustedBy: actor.userId });
  current.photoAssetIds.push(new Types.ObjectId(input.photoAssetId)); current.history.push({ before: { status: current.status, checkInAt: current.checkInAt, checkOutAt: null, reason: current.reason }, after, actorId: actor.userId, at: new Date() });
  await current.save();
  await recordAudit({ actor, action: "attendance.guard_check_out", entityType: "attendance_adjustment", entityId: current._id.toString(), organizationId, after: { attendanceDate, officeLocationId: office?._id?.toString() ?? null }, meta });
  return { id: current._id.toString(), employeeId: employee!._id.toString(), employee: { name: employee!.name, email: employee!.email }, attendanceDate, ...after, adjustedBy: actor.userId };
}

export async function createCorrectionRequest(actor: AuthContext, organizationId: string, input: CorrectionInput, meta: RequestMeta) {
  const policy = await AttendancePolicyModel.findOne({ organizationId });
  if (policy?.correctionRequestsEnabled === false) throw new AppError("FEATURE_DISABLED", "Attendance correction requests are disabled", 403);
  const record = await AttendanceRecordModel.findOne({ _id: input.attendanceRecordId, organizationId, employeeId: actor.userId });
  if (!record?.checkIn) throw new AppError("NOT_FOUND", "Your attendance record was not found", 404);
  if (await AttendanceAdjustmentModel.exists({ organizationId, employeeId: actor.userId, attendanceDate: record.attendanceDate })) throw new AppError("INVALID_STATE", "This attendance was manually adjusted by an administrator. Contact them for further changes.", 409);
  const requestedCheckInAt = input.requestedCheckInAt ? new Date(input.requestedCheckInAt) : null;
  const requestedCheckOutAt = input.requestedCheckOutAt ? new Date(input.requestedCheckOutAt) : null;
  const proposedCheckIn = requestedCheckInAt ?? record.checkIn.at;
  const existingCheckOut = record.checkOut?.at ?? record.correctedCheckOutAt ?? null;
  const proposedCheckOut = requestedCheckOutAt ?? existingCheckOut;
  const organization = await assertTenantAccessible(organizationId);
  const isSameAttendanceDate = (date: Date) => dateForTimezone(date, organization.timezone) === record.attendanceDate;
  if (requestedCheckInAt && (requestedCheckInAt > new Date() || !isSameAttendanceDate(requestedCheckInAt))) throw new AppError("VALIDATION_ERROR", "Corrected check-in must be on the attendance date and not in the future", 422);
  if (requestedCheckOutAt && (requestedCheckOutAt > new Date() || !isSameAttendanceDate(requestedCheckOutAt))) throw new AppError("VALIDATION_ERROR", "Corrected check-out must be on the attendance date and not in the future", 422);
  if (proposedCheckOut && proposedCheckOut <= proposedCheckIn) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in", 422);
  const evidence = input.evidenceFileAssetId
    ? await FileAssetModel.findOne({ _id: input.evidenceFileAssetId, organizationId, uploadedBy: actor.userId })
    : null;
  if (input.evidenceFileAssetId && !evidence) throw new AppError("NOT_FOUND", "Correction evidence was not found", 404);
  const existing = await AttendanceCorrectionModel.findOne({ organizationId, attendanceRecordId: record._id, status: "pending" });
  if (existing) throw new AppError("CONFLICT", "A correction request is already pending for this attendance", 409);
  const correction = await AttendanceCorrectionModel.create({ organizationId, attendanceRecordId: record._id, employeeId: actor.userId, requestedCheckInAt, requestedCheckOutAt, reason: input.reason, evidenceFileAssetId: evidence?._id ?? null });
  await recordAudit({ actor, action: "attendance.correction_requested", entityType: "attendance_correction", entityId: correction._id.toString(), organizationId, after: { attendanceRecordId: record._id.toString(), requestedCheckInAt, requestedCheckOutAt, reason: input.reason }, meta });
  return presentCorrection(correction);
}

function presentCorrection(correction: {
  _id: { toString(): string }; attendanceRecordId: { toString(): string }; employeeId: { toString(): string };
  requestedCheckInAt?: Date | null; requestedCheckOutAt?: Date | null; reason: string; evidenceFileAssetId?: { toString(): string } | null;
  status: string; reviewedBy?: { toString(): string } | null; reviewedAt?: Date | null;
  reviewComment?: string; createdAt: Date;
}) {
  return { id: correction._id.toString(), attendanceRecordId: correction.attendanceRecordId.toString(), employeeId: correction.employeeId.toString(), requestedCheckInAt: correction.requestedCheckInAt ?? null, requestedCheckOutAt: correction.requestedCheckOutAt ?? null, reason: correction.reason, evidenceFileAssetId: correction.evidenceFileAssetId?.toString() ?? null, status: correction.status, reviewedBy: correction.reviewedBy?.toString() ?? null, reviewedAt: correction.reviewedAt ?? null, reviewComment: correction.reviewComment ?? "", createdAt: correction.createdAt };
}

export async function listCorrections(organizationId: string, query: CorrectionQuery) {
  const filter = { organizationId, ...(query.status ? { status: query.status } : {}) };
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    AttendanceCorrectionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AttendanceCorrectionModel.countDocuments(filter),
  ]);
  const employeeIds = [...new Set(corrections.map((correction) => correction.employeeId.toString()))];
  const [employees, records] = await Promise.all([
    UserModel.find({ _id: { $in: employeeIds }, organizationId }).select("name email"),
    AttendanceRecordModel.find({ _id: { $in: corrections.map((correction) => correction.attendanceRecordId) }, organizationId }).select("attendanceDate checkIn.at checkOut.at correctedCheckOutAt"),
  ]);
  const employeeMap = new Map(employees.map((employee) => [employee._id.toString(), { name: employee.name, email: employee.email }]));
  const recordMap = new Map(records.map((record) => [record._id.toString(), { attendanceDate: record.attendanceDate, currentCheckInAt: record.checkIn?.at ?? null, currentCheckOutAt: record.checkOut?.at ?? record.correctedCheckOutAt ?? null }]));
  return { items: corrections.map((correction) => ({ ...presentCorrection(correction), ...recordMap.get(correction.attendanceRecordId.toString()), employee: employeeMap.get(correction.employeeId.toString()) ?? null })), meta: { page: query.page, limit: query.limit, total } };
}

export async function listEmployeeCorrections(actor: AuthContext, organizationId: string, query: CorrectionQuery) {
  const filter = { organizationId, employeeId: actor.userId, ...(query.status ? { status: query.status } : {}) };
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    AttendanceCorrectionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    AttendanceCorrectionModel.countDocuments(filter),
  ]);
  const records = await AttendanceRecordModel.find({ _id: { $in: corrections.map((correction) => correction.attendanceRecordId) }, organizationId }).select("attendanceDate checkIn.at checkOut.at correctedCheckOutAt");
  const recordMap = new Map(records.map((record) => [record._id.toString(), { attendanceDate: record.attendanceDate, currentCheckInAt: record.checkIn?.at ?? null, currentCheckOutAt: record.checkOut?.at ?? record.correctedCheckOutAt ?? null }]));
  return { items: corrections.map((correction) => ({ ...presentCorrection(correction), ...recordMap.get(correction.attendanceRecordId.toString()) })), meta: { page: query.page, limit: query.limit, total } };
}

export async function reviewCorrection(actor: AuthContext, organizationId: string, correctionId: string, input: CorrectionReview, meta: RequestMeta) {
  const correction = await AttendanceCorrectionModel.findOne({ _id: correctionId, organizationId, status: "pending" });
  if (!correction) throw new AppError("NOT_FOUND", "Pending correction request not found", 404);
  const record = await AttendanceRecordModel.findOne({ _id: correction.attendanceRecordId, organizationId, employeeId: correction.employeeId });
  if (!record?.checkIn) throw new AppError("INVALID_STATE", "Attendance record cannot accept this correction", 409);
  const before = { status: record.status, checkInAt: record.checkIn.at, checkOutAt: record.checkOut?.at ?? null, correctedCheckOutAt: record.correctedCheckOutAt ?? null };
  correction.status = input.decision;
  correction.reviewedBy = new Types.ObjectId(actor.userId);
  correction.reviewedAt = new Date();
  correction.reviewComment = input.comment;
  if (input.decision === "approved") {
    const policy = await AttendancePolicyModel.findOne({ organizationId });
    const changes: Record<string, unknown> = {};
    if (correction.requestedCheckInAt) {
      changes.checkInAt = { before: record.checkIn.at, after: correction.requestedCheckInAt };
      record.checkIn.at = correction.requestedCheckInAt;
    }
    if (correction.requestedCheckOutAt) {
      const priorCheckOutAt = record.checkOut?.at ?? record.correctedCheckOutAt ?? null;
      changes.checkOutAt = { before: priorCheckOutAt, after: correction.requestedCheckOutAt };
      if (record.checkOut) record.checkOut.at = correction.requestedCheckOutAt;
      else record.correctedCheckOutAt = correction.requestedCheckOutAt;
      record.correctionId = correction._id;
      record.status = "completed";
    }
    const effectiveCheckOutAt = record.checkOut?.at ?? record.correctedCheckOutAt ?? null;
    if (effectiveCheckOutAt) {
      const organization = await assertTenantAccessible(organizationId);
      const profile = await WorkforceEmployeeModel.findOne({ organizationId, userId: record.employeeId, status: "active" }).select("_id");
      const assignedShift: any = profile ? await getEffectiveShiftForDate(organizationId, profile._id, record.attendanceDate) : null;
      const workingResult = calculateWorkingMinutes(record.checkIn.at, effectiveCheckOutAt, assignedShift, record.attendanceDate, organization.timezone);

      record.totalWorkingMinutes = workingResult.totalWorkingMinutes;
      (record as any).unpaidBreakMinutes = workingResult.unpaidBreakMinutes;

      let halfDayThreshold = (policy?.halfDayHours ?? 4) * 60;
      if (assignedShift?.startTime && assignedShift?.endTime) {
        const scheduledMinutes = calculateScheduledShiftMinutes(assignedShift.startTime, assignedShift.endTime, Boolean(assignedShift.crossesMidnight));
        halfDayThreshold = Math.min(halfDayThreshold, Math.floor(scheduledMinutes / 2));
      }
      record.halfDay = record.totalWorkingMinutes < halfDayThreshold;
    }
    correction.appliedChange = { fields: changes, approvedBy: actor.userId, reason: correction.reason };
    await record.save();
  }
  await correction.save();
  await recordAudit({ actor, action: `attendance.correction_${input.decision}`, entityType: "attendance_correction", entityId: correction._id.toString(), organizationId, before, after: { status: record.status, correctionStatus: correction.status, requestedCheckInAt: correction.requestedCheckInAt, requestedCheckOutAt: correction.requestedCheckOutAt, reviewComment: correction.reviewComment }, reason: input.comment || correction.reason, meta });
  return presentCorrection(correction);
}
