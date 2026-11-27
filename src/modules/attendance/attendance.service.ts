import { usesActionPermissions, type AuthContext } from "../../common/auth/auth-context.js";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, type SQL } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import {
  attendanceAdjustments,
  attendanceCorrections,
  attendancePolicies,
  attendanceRecords,
  fileAssets,
  leaveRequests,
  leaveTypes,
  officeLocations,
  users,
  workforceEmployees,
  type AdjustmentHistoryEntry,
  type AdjustmentSnapshot,
  type AttendanceStatus,
  type Punch,
  type PunchLocation,
} from "../../database/schema.js";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { effectiveUserAccess } from "../users/user-access.service.js";
import { evaluateGeofence, haversineMeters } from "./geofence.js";
import { previousDay, shouldUsePreviousOvernightWorkday } from "./workday.js";
import { calculateScheduledShiftMinutes, calculateWorkingMinutes } from "./break-calculator.js";
import { getEffectiveShiftForDate } from "./effective-shift.js";
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

type AttendanceRecordRow = typeof attendanceRecords.$inferSelect;
type AttendanceAdjustmentRow = typeof attendanceAdjustments.$inferSelect;
type AttendanceCorrectionRow = typeof attendanceCorrections.$inferSelect;
type OfficeLocationRow = typeof officeLocations.$inferSelect;

const ADJUSTABLE_ROLES = ["employee", "field_recovery", "accounts_manager", "sub_admin", "org_admin", "guard"];

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

/** Converts an adjustment snapshot with Date values into the JSONB form (ISO strings). */
function snapshotJson(snapshot: { status: string; checkInAt: Date | null; checkOutAt: Date | null; reason: string } | null): AdjustmentSnapshot | null {
  if (!snapshot) return null;
  return {
    status: snapshot.status as AttendanceStatus,
    checkInAt: snapshot.checkInAt ? snapshot.checkInAt.toISOString() : null,
    checkOutAt: snapshot.checkOutAt ? snapshot.checkOutAt.toISOString() : null,
    reason: snapshot.reason,
  };
}

function historyEntry(
  before: { status: string; checkInAt: Date | null; checkOutAt: Date | null; reason: string } | null,
  after: { status: string; checkInAt: Date | null; checkOutAt: Date | null; reason: string },
  actorId: string,
): AdjustmentHistoryEntry {
  return { before: snapshotJson(before), after: snapshotJson(after)!, actorId, at: new Date().toISOString() };
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

async function findPolicy(organizationId: string) {
  const rows = await db.select().from(attendancePolicies).where(eq(attendancePolicies.organizationId, organizationId)).limit(1);
  return rows[0] ?? null;
}

/** Returns the organization's policy, creating it with defaults when missing (former upsert + $setOnInsert). */
async function ensurePolicy(organizationId: string) {
  const existing = await findPolicy(organizationId);
  if (existing) return existing;
  await db.insert(attendancePolicies).values({ organizationId }).onConflictDoNothing({ target: attendancePolicies.organizationId });
  return (await findPolicy(organizationId))!;
}

async function findActiveProfileIdForUser(organizationId: string, userId: string): Promise<string | null> {
  const rows = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, organizationId), eq(workforceEmployees.userId, userId), eq(workforceEmployees.status, "active")))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function adjustmentExists(organizationId: string, employeeId: string, attendanceDate: string): Promise<boolean> {
  const rows = await db.select({ id: attendanceAdjustments.id }).from(attendanceAdjustments)
    .where(and(eq(attendanceAdjustments.organizationId, organizationId), eq(attendanceAdjustments.employeeId, employeeId), eq(attendanceAdjustments.attendanceDate, attendanceDate)))
    .limit(1);
  return rows.length > 0;
}

export async function getAttendanceConfig(actorOrOrgId: AuthContext | string, possibleOrgId?: string) {
  const organizationId = typeof actorOrOrgId === "string" ? actorOrOrgId : possibleOrgId!;
  const actor = typeof actorOrOrgId === "string" ? null : actorOrOrgId;
  const organization = await assertTenantAccessible(organizationId);
  const policy = await ensurePolicy(organizationId);
  const locations = await db.select().from(officeLocations).where(eq(officeLocations.organizationId, organizationId)).orderBy(asc(officeLocations.name));

  let todayShift = null;
  if (actor) {
    const today = dateForTimezone(new Date(), organization.timezone);
    const profileId = await findActiveProfileIdForUser(organizationId, actor.userId);
    const assignedShift = profileId ? await getEffectiveShiftForDate(organizationId, profileId, today) : null;
    if (assignedShift) {
      const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
      const isWeeklyOff = assignedShift.weeklyOffs?.includes(weekday) ?? false;
      todayShift = {
        id: assignedShift.id,
        name: assignedShift.name,
        shiftType: assignedShift.shiftType,
        startTime: assignedShift.startTime,
        endTime: assignedShift.endTime,
        crossesMidnight: Boolean(assignedShift.crossesMidnight),
        flexibleWindowMinutes: assignedShift.flexibleWindowMinutes ?? 0,
        breaks: (assignedShift.breaks ?? []).map((brk) => ({
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
      id: location.id, name: location.name, address: location.address,
      latitude: location.latitude, longitude: location.longitude,
      geofenceRadiusM: location.geofenceRadiusM, status: location.status,
    })),
    todayShift,
  };
}

export async function listAttendanceEmployees(organizationId: string) {
  const linkedUserIds = (await db.selectDistinct({ userId: workforceEmployees.userId }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, organizationId), isNotNull(workforceEmployees.userId))))
    .map((row) => row.userId!)
    .filter(Boolean);
  const [profiles, userRows] = await Promise.all([
    db.select({ profile: workforceEmployees, linkedUser: { id: users.id, email: users.email } }).from(workforceEmployees)
      .leftJoin(users, eq(users.id, workforceEmployees.userId))
      .where(and(eq(workforceEmployees.organizationId, organizationId), eq(workforceEmployees.status, "active")))
      .orderBy(asc(workforceEmployees.lastName), asc(workforceEmployees.firstName)),
    db.select({ id: users.id, name: users.name, email: users.email }).from(users)
      .where(and(
        eq(users.organizationId, organizationId),
        eq(users.status, "active"),
        inArray(users.role, ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee", "guard"]),
        linkedUserIds.length ? notInArray(users.id, linkedUserIds) : undefined,
      ))
      .orderBy(asc(users.name)),
  ]);
  return [
    ...profiles.map(({ profile, linkedUser }) => ({ id: linkedUser?.id ?? profile.id, name: `${profile.firstName} ${profile.lastName}`.trim(), email: linkedUser?.email ?? profile.email ?? "", employeeNumber: profile.employeeNumber, profileId: profile.id, hasLogin: Boolean(linkedUser) })),
    ...userRows.map((user) => ({ id: user.id, name: user.name, email: user.email, employeeNumber: "", profileId: null, hasLogin: true })),
  ];
}

export async function updateAttendancePolicy(
  actor: AuthContext, organizationId: string, input: PolicyInput, meta: RequestMeta,
) {
  const [policy] = await db.insert(attendancePolicies).values({ ...input, organizationId })
    .onConflictDoUpdate({ target: attendancePolicies.organizationId, set: { ...input, updatedAt: new Date() } })
    .returning();
  await recordAudit({ actor, action: "attendance.policy_updated", entityType: "attendance_policy", entityId: policy.id, organizationId, after: policyView(policy), meta });
  return policyView(policy);
}

export async function createOfficeLocation(actor: AuthContext, organizationId: string, input: LocationInput, meta: RequestMeta) {
  const [location] = await db.insert(officeLocations).values({ ...input, name: input.name.trim(), address: input.address.trim(), organizationId }).returning();
  await recordAudit({ actor, action: "attendance.office_created", entityType: "office_location", entityId: location.id, organizationId, after: input, meta });
  return { id: location.id, ...input };
}

export async function updateOfficeLocation(actor: AuthContext, organizationId: string, locationId: string, input: LocationInput, meta: RequestMeta) {
  const [location] = await db.select().from(officeLocations).where(and(eq(officeLocations.id, locationId), eq(officeLocations.organizationId, organizationId))).limit(1);
  if (!location) throw new AppError("NOT_FOUND", "Office location not found", 404);
  const before = { name: location.name, address: location.address, latitude: location.latitude, longitude: location.longitude, geofenceRadiusM: location.geofenceRadiusM, status: location.status };
  await db.update(officeLocations).set({ ...input, name: input.name.trim(), address: input.address.trim() }).where(eq(officeLocations.id, location.id));
  await recordAudit({ actor, action: "attendance.office_updated", entityType: "office_location", entityId: location.id, organizationId, before, after: input, meta });
  return { id: location.id, ...input };
}

export async function deleteOfficeLocation(actor: AuthContext, organizationId: string, locationId: string, meta: RequestMeta) {
  const [location] = await db.update(officeLocations).set({ status: "inactive" })
    .where(and(eq(officeLocations.id, locationId), eq(officeLocations.organizationId, organizationId), eq(officeLocations.status, "active")))
    .returning();
  if (!location) throw new AppError("NOT_FOUND", "Active office location not found", 404);
  await recordAudit({ actor, action: "attendance.office_deleted", entityType: "office_location", entityId: location.id, organizationId, before: { status: "active", name: location.name }, after: { status: "inactive" }, meta });
  return { id: location.id, status: location.status };
}

async function validatePunch(
  actor: AuthContext,
  organizationId: string,
  input: PunchInput,
  officeLocationId: string,
  timestamp: Date,
): Promise<{ office: OfficeLocationRow | null; punch: Punch }> {
  const [officeRows, policy, photoRows] = await Promise.all([
    officeLocationId
      ? db.select().from(officeLocations).where(and(eq(officeLocations.id, officeLocationId), eq(officeLocations.organizationId, organizationId), eq(officeLocations.status, "active"))).limit(1)
      : Promise.resolve([] as OfficeLocationRow[]),
    findPolicy(organizationId),
    db.select({ id: fileAssets.id }).from(fileAssets).where(and(
      eq(fileAssets.id, input.photoAssetId),
      eq(fileAssets.organizationId, organizationId),
      eq(fileAssets.purpose, "attendance_photo"),
      eq(fileAssets.uploadedBy, actor.userId),
    )).limit(1),
  ]);
  const office = officeRows[0] ?? null;
  const photo = photoRows[0] ?? null;
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
      at: timestamp.toISOString(),
      latitude: hasLocation ? input.latitude! : null,
      longitude: hasLocation ? input.longitude! : null,
      gpsAccuracyM: hasLocation ? input.gpsAccuracyM! : null,
      officeDistanceM: distance === null ? null : Math.round(distance),
      locationVerification: strict ? "verified" : "not_enforced",
      photoAssetId: input.photoAssetId,
    },
  };
}

export async function checkIn(actor: AuthContext, organizationId: string, input: PunchInput & { officeLocationId?: string }, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const timestamp = new Date();
  const localDate = dateForTimezone(timestamp, organization.timezone);
  const localMinute = minuteOfDay(timestamp, organization.timezone);
  const profileId = await findActiveProfileIdForUser(organizationId, actor.userId);
  const previousShift = profileId ? await getEffectiveShiftForDate(organizationId, profileId, previousDay(localDate)) : null;
  const previousShiftInfo = previousShift ? { crossesMidnight: Boolean(previousShift.crossesMidnight), endTime: previousShift.endTime } : null;
  const date = shouldUsePreviousOvernightWorkday(localMinute, previousShiftInfo) ? previousDay(localDate) : localDate;
  const [openAttendance] = await db.select({ id: attendanceRecords.id }).from(attendanceRecords)
    .where(and(eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.employeeId, actor.userId), eq(attendanceRecords.status, "checked_in")))
    .limit(1);
  if (openAttendance) throw new AppError("INVALID_STATE", "You already have an open attendance shift. Check out before starting another.", 409);
  const [existing] = await db.select({ status: attendanceRecords.status }).from(attendanceRecords)
    .where(and(eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.employeeId, actor.userId), eq(attendanceRecords.attendanceDate, date)))
    .limit(1);
  if (existing) throw new AppError("INVALID_STATE", existing.status === "checked_in" ? "You are already checked in" : "Attendance is already complete for today", 409);
  if (await adjustmentExists(organizationId, actor.userId, date)) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for today", 409);
  const { office, punch } = await validatePunch(actor, organizationId, input, input.officeLocationId ?? "", timestamp);
  const policy = await findPolicy(organizationId);
  const assignedShift = profileId ? await getEffectiveShiftForDate(organizationId, profileId, date) : null;
  const [expectedHour, expectedMinute] = (assignedShift?.startTime ?? policy?.expectedCheckIn ?? "09:00").split(":").map(Number);
  const graceMinutes = (policy?.gracePeriodMinutes ?? 10) + (assignedShift?.flexibleWindowMinutes ?? 0);
  const punchMinuteOnWorkday = localMinute + (date !== localDate ? 1440 : 0);
  const lateArrival = punchMinuteOnWorkday > expectedHour * 60 + expectedMinute + graceMinutes;
  try {
    const [record] = await db.insert(attendanceRecords).values({
      organizationId,
      employeeId: actor.userId,
      attendanceDate: date,
      officeLocationId: office?.id ?? null,
      shiftId: assignedShift?.id ?? null,
      shiftName: assignedShift?.name ?? null,
      checkIn: punch,
      status: "checked_in",
      lateArrival,
    }).returning();
    await recordAudit({
      actor,
      action: "attendance.checked_in",
      entityType: "attendance",
      entityId: record.id,
      organizationId,
      after: {
        attendanceDate: date,
        officeLocationId: office?.id ?? null,
        shiftId: assignedShift?.id ?? null,
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

/** Half-day threshold in minutes: policy half-day hours, capped at half the scheduled shift length. */
function halfDayThresholdMinutes(policy: { halfDayHours: number } | null, assignedShift: { startTime: string; endTime: string; crossesMidnight: boolean } | null) {
  let halfDayThreshold = (policy?.halfDayHours ?? 4) * 60;
  if (assignedShift?.startTime && assignedShift?.endTime) {
    const scheduledMinutes = calculateScheduledShiftMinutes(assignedShift.startTime, assignedShift.endTime, Boolean(assignedShift.crossesMidnight));
    halfDayThreshold = Math.min(halfDayThreshold, Math.floor(scheduledMinutes / 2));
  }
  return halfDayThreshold;
}

export async function checkOut(actor: AuthContext, organizationId: string, input: PunchInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const [record] = await db.select().from(attendanceRecords)
    .where(and(eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.employeeId, actor.userId), eq(attendanceRecords.status, "checked_in")))
    .orderBy(desc(attendanceRecords.createdAt))
    .limit(1);
  if (!record || !record.checkIn) throw new AppError("INVALID_STATE", "You do not have an open check-in", 409);
  if (await adjustmentExists(organizationId, actor.userId, record.attendanceDate)) throw new AppError("INVALID_STATE", "An administrator has already set your attendance for this shift", 409);
  const timestamp = new Date();
  const checkInAt = new Date(record.checkIn.at);
  if (timestamp <= checkInAt) throw new AppError("INVALID_STATE", "Check-out time must be after check-in", 422);
  if (timestamp.getTime() - checkInAt.getTime() > 36 * 60 * 60 * 1000) throw new AppError("INVALID_STATE", "This check-in is too old to check out. Submit an attendance correction request.", 409);
  const { punch } = await validatePunch(actor, organizationId, input, record.officeLocationId ?? "", timestamp);
  const policy = await findPolicy(organizationId);

  const profileId = await findActiveProfileIdForUser(organizationId, actor.userId);
  const assignedShift = profileId ? await getEffectiveShiftForDate(organizationId, profileId, record.attendanceDate) : null;
  const workingResult = calculateWorkingMinutes(checkInAt, timestamp, assignedShift, record.attendanceDate, organization.timezone);
  const halfDay = workingResult.totalWorkingMinutes < halfDayThresholdMinutes(policy, assignedShift);

  const [updated] = await db.update(attendanceRecords).set({
    checkOut: punch,
    status: "completed",
    totalWorkingMinutes: workingResult.totalWorkingMinutes,
    unpaidBreakMinutes: workingResult.unpaidBreakMinutes,
    halfDay,
  }).where(and(eq(attendanceRecords.id, record.id), eq(attendanceRecords.status, "checked_in"))).returning();
  if (!updated) throw new AppError("INVALID_STATE", "You do not have an open check-in", 409);
  await recordAudit({
    actor,
    action: "attendance.checked_out",
    entityType: "attendance",
    entityId: updated.id,
    organizationId,
    after: {
      attendanceDate: updated.attendanceDate,
      totalWorkingMinutes: updated.totalWorkingMinutes,
      unpaidBreakMinutes: updated.unpaidBreakMinutes,
      photoAssetId: punch.photoAssetId,
      officeDistanceM: punch.officeDistanceM,
      gpsAccuracyM: punch.gpsAccuracyM,
    },
    meta,
  });
  return presentRecord(updated);
}

function presentRecord(record: AttendanceRecordRow) {
  return {
    id: record.id,
    employeeId: record.employeeId,
    attendanceDate: record.attendanceDate,
    officeLocationId: record.officeLocationId ?? null,
    shiftId: record.shiftId ?? null,
    shiftName: record.shiftName ?? null,
    checkIn: record.checkIn ?? null,
    checkOut: record.checkOut ?? null,
    correctedCheckOutAt: record.correctedCheckOutAt ?? null,
    correctionId: record.correctionId ?? null,
    status: record.status,
    lateArrival: record.lateArrival,
    totalWorkingMinutes: record.totalWorkingMinutes ?? null,
    unpaidBreakMinutes: record.unpaidBreakMinutes ?? 0,
    halfDay: record.halfDay,
  };
}

export async function listAttendanceRecords(actor: AuthContext, organizationId: string, query: RecordQuery) {
  const actionScoped = usesActionPermissions(actor);
  const access = actionScoped ? await effectiveUserAccess(actor.userId) : null;
  const isAdmin = actor.role === "org_admin" || (!actionScoped && actor.role === "accounts_manager") || (actionScoped && Boolean(access?.actions.includes("attendance.view_all") || access?.actions.includes("attendance.adjust")));
  const employeeId = isAdmin ? (query.employeeId ?? undefined) : actor.userId;
  const hasDateRange = Boolean(query.from || query.to);
  const recordConditions: (SQL | undefined)[] = [
    eq(attendanceRecords.organizationId, organizationId),
    employeeId ? eq(attendanceRecords.employeeId, employeeId) : undefined,
    query.from ? gte(attendanceRecords.attendanceDate, query.from) : undefined,
    query.to ? lte(attendanceRecords.attendanceDate, query.to) : undefined,
  ];
  const adjustmentConditions: (SQL | undefined)[] = [
    eq(attendanceAdjustments.organizationId, organizationId),
    employeeId ? eq(attendanceAdjustments.employeeId, employeeId) : undefined,
    query.from ? gte(attendanceAdjustments.attendanceDate, query.from) : undefined,
    query.to ? lte(attendanceAdjustments.attendanceDate, query.to) : undefined,
  ];
  const [records, adjustments] = await Promise.all([
    db.select().from(attendanceRecords).where(and(...recordConditions)).orderBy(desc(attendanceRecords.attendanceDate), desc(attendanceRecords.createdAt)),
    db.select().from(attendanceAdjustments).where(and(...adjustmentConditions)),
  ]);
  const adjustmentMap = new Map(adjustments.map((item) => [`${item.employeeId}:${item.attendanceDate}`, item]));
  const recordKeys = new Set(records.map((item) => `${item.employeeId}:${item.attendanceDate}`));
  const manualAdjustment = (adjustment: AttendanceAdjustmentRow) => ({ id: adjustment.id, reason: adjustment.reason, checkInAt: adjustment.checkInAt, checkOutAt: adjustment.checkOutAt, adjustedBy: adjustment.adjustedBy });
  const combined: Array<Record<string, any>> = records.map((record) => {
    const base = presentRecord(record);
    const adjustment = adjustmentMap.get(`${record.employeeId}:${record.attendanceDate}`);
    return adjustment ? { ...base, status: adjustment.status, halfDay: adjustment.status === "half_day", manualAdjustment: manualAdjustment(adjustment), checkIn: ["present", "half_day"].includes(adjustment.status) && adjustment.checkInAt ? { ...(base.checkIn ?? {}), at: adjustment.checkInAt, photoAssetId: base.checkIn?.photoAssetId ?? null, manuallyEntered: true } : base.checkIn, checkOut: ["present", "half_day"].includes(adjustment.status) && adjustment.checkOutAt ? { ...(base.checkOut ?? {}), at: adjustment.checkOutAt, photoAssetId: base.checkOut?.photoAssetId ?? null, manuallyEntered: true } : base.checkOut } : base;
  });
  for (const adjustment of adjustments) if (!recordKeys.has(`${adjustment.employeeId}:${adjustment.attendanceDate}`)) combined.push({ id: `adjustment-${adjustment.id}`, employeeId: adjustment.employeeId, attendanceDate: adjustment.attendanceDate, officeLocationId: adjustment.officeLocationId ?? null, checkIn: ["present", "half_day"].includes(adjustment.status) && adjustment.checkInAt ? { at: adjustment.checkInAt, photoAssetId: null, manuallyEntered: true } : null, checkOut: ["present", "half_day"].includes(adjustment.status) && adjustment.checkOutAt ? { at: adjustment.checkOutAt, photoAssetId: null, manuallyEntered: true } : null, status: adjustment.status, lateArrival: false, totalWorkingMinutes: adjustment.checkInAt && adjustment.checkOutAt ? Math.floor((adjustment.checkOutAt.getTime() - adjustment.checkInAt.getTime()) / 60_000) : null, halfDay: adjustment.status === "half_day", manualAdjustment: manualAdjustment(adjustment) });
  const profiles = await db.select({ id: workforceEmployees.id, userId: workforceEmployees.userId }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, organizationId), employeeId ? eq(workforceEmployees.userId, employeeId) : isNotNull(workforceEmployees.userId)));
  const profileIds = profiles.map((profile) => profile.id);
  if (profileIds.length) {
    const lower = query.from ?? "0000-01-01"; const upper = query.to ?? "9999-12-31";
    const approvedLeave = await db.select({ leave: leaveRequests, leaveType: { name: leaveTypes.name, paid: leaveTypes.paid } }).from(leaveRequests)
      .leftJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(
        eq(leaveRequests.organizationId, organizationId),
        inArray(leaveRequests.employeeId, profileIds),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startDate, upper),
        gte(leaveRequests.endDate, lower),
      ));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const { leave, leaveType } of approvedLeave) {
      const profile = profileById.get(leave.employeeId);
      if (!profile?.userId) continue;
      const requestStart = new Date(`${leave.startDate}T12:00:00.000Z`); const requestEnd = new Date(`${leave.endDate}T12:00:00.000Z`);
      for (const day = new Date(requestStart); day <= requestEnd; day.setUTCDate(day.getUTCDate() + 1)) {
        const attendanceDate = day.toISOString().slice(0, 10);
        if ((hasDateRange && (attendanceDate < lower || attendanceDate > upper))) continue;
        const key = `${profile.userId}:${attendanceDate}`;
        if (recordKeys.has(key) || adjustmentMap.has(key)) continue;
        combined.push({ id: `leave-${leave.id}-${attendanceDate}`, employeeId: profile.userId, attendanceDate, officeLocationId: null, checkIn: null, checkOut: null, status: "leave", lateArrival: false, totalWorkingMinutes: null, halfDay: leave.days < Math.round((requestEnd.getTime() - requestStart.getTime()) / 86400000) + 1, leaveRequest: { id: leave.id, type: leaveType?.name ?? "Leave", paid: leaveType?.paid ?? false } });
      }
    }
  }
  const filtered = combined.filter((record) => (!query.officeLocationId || record.officeLocationId === query.officeLocationId) && (!query.status || record.status === query.status || (query.status === "present" && record.status === "completed") || (query.status === "completed" && record.status === "present"))).sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  const total = filtered.length;
  const skip = (query.page - 1) * query.limit;
  const pageItems = filtered.slice(skip, skip + query.limit);
  const employeeIds = [...new Set(pageItems.map((record) => record.employeeId as string))];
  const officeIds = [...new Set(pageItems.map((record) => record.officeLocationId as string | null).filter((id): id is string => Boolean(id)))];
  const [employees, profileEmployees, offices] = await Promise.all([
    employeeIds.length ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(inArray(users.id, employeeIds), eq(users.organizationId, organizationId))) : Promise.resolve([]),
    employeeIds.length ? db.select({ id: workforceEmployees.id, firstName: workforceEmployees.firstName, lastName: workforceEmployees.lastName, email: workforceEmployees.email }).from(workforceEmployees).where(and(inArray(workforceEmployees.id, employeeIds), eq(workforceEmployees.organizationId, organizationId))) : Promise.resolve([]),
    officeIds.length ? db.select({ id: officeLocations.id, name: officeLocations.name }).from(officeLocations).where(and(inArray(officeLocations.id, officeIds), eq(officeLocations.organizationId, organizationId))) : Promise.resolve([]),
  ]);
  const employeeNames = new Map(employees.map((employee) => [employee.id, { name: employee.name, email: employee.email }]));
  for (const employee of profileEmployees) employeeNames.set(employee.id, { name: `${employee.firstName} ${employee.lastName}`.trim(), email: employee.email });
  const officeNames = new Map(offices.map((office) => [office.id, office.name]));
  return {
    items: pageItems.map((record) => ({ ...record, employee: employeeNames.get(record.employeeId) ?? null, officeName: record.officeLocationId ? officeNames.get(record.officeLocationId) ?? "Office" : "—" })),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function attendanceDashboard(organizationId: string, date?: string) {
  const organization = await assertTenantAccessible(organizationId);
  const attendanceDate = date ?? dateForTimezone(new Date(), organization.timezone);
  const weekday = new Date(`${attendanceDate}T12:00:00.000Z`).getUTCDay();
  const policy = await findPolicy(organizationId);
  const holiday = policy?.weeklyHolidays.includes(weekday) ?? weekday === 0;
  const [userCount, profileCount, records, pendingCorrections] = await Promise.all([
    db.$count(users, and(eq(users.organizationId, organizationId), eq(users.status, "active"), inArray(users.role, ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee"]))),
    db.$count(workforceEmployees, and(eq(workforceEmployees.organizationId, organizationId), eq(workforceEmployees.status, "active"), isNull(workforceEmployees.userId))),
    db.select({ employeeId: attendanceRecords.employeeId, lateArrival: attendanceRecords.lateArrival, status: attendanceRecords.status }).from(attendanceRecords)
      .where(and(eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.attendanceDate, attendanceDate))),
    db.$count(attendanceCorrections, and(eq(attendanceCorrections.organizationId, organizationId), eq(attendanceCorrections.status, "pending"))),
  ]);
  const adjustments = await db.select({ employeeId: attendanceAdjustments.employeeId, status: attendanceAdjustments.status }).from(attendanceAdjustments)
    .where(and(eq(attendanceAdjustments.organizationId, organizationId), eq(attendanceAdjustments.attendanceDate, attendanceDate)));
  const adjusted = new Map(adjustments.map((item) => [item.employeeId, item]));
  const present = new Set(records.map((record) => record.employeeId).filter((id) => adjusted.get(id)?.status !== "absent" && adjusted.get(id)?.status !== "leave"));
  for (const item of adjustments) if (item.status === "present") present.add(item.employeeId);
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

async function findActiveUser(organizationId: string, userId: string, restrictRoles: boolean) {
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(
    eq(users.id, userId),
    eq(users.organizationId, organizationId),
    eq(users.status, "active"),
    restrictRoles ? inArray(users.role, ADJUSTABLE_ROLES) : undefined,
  )).limit(1);
  return rows[0] ?? null;
}

export async function upsertAttendanceAdjustment(actor: AuthContext, organizationId: string, input: AdjustmentInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  if (input.attendanceDate > dateForTimezone(new Date(), organization.timezone)) throw new AppError("VALIDATION_ERROR", "Attendance cannot be set for a future date", 422);
  const employee = await findActiveUser(organizationId, input.employeeId, true);
  const profile = employee ? null : (await db.select().from(workforceEmployees)
    .where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, organizationId), eq(workforceEmployees.status, "active"))).limit(1))[0] ?? null;
  if (!employee && !profile) throw new AppError("NOT_FOUND", "Active organization employee profile not found", 404);
  const targetId = employee?.id ?? profile!.id;
  const checkInAt = input.checkInAt ? new Date(input.checkInAt) : null;
  const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;
  if (input.photoAssetId) {
    const photo = await db.select({ id: fileAssets.id }).from(fileAssets).where(and(eq(fileAssets.id, input.photoAssetId), eq(fileAssets.organizationId, organizationId), eq(fileAssets.purpose, "attendance_photo"), eq(fileAssets.uploadedBy, actor.userId))).limit(1);
    if (!photo.length) throw new AppError("NOT_FOUND", "Uploaded attendance photo not found", 404);
  }
  if (input.status === "present" || input.status === "half_day") {
    if (input.status === "present" && !checkInAt) throw new AppError("VALIDATION_ERROR", "Present attendance requires a check-in time", 422);
    if (checkInAt && checkInAt > new Date()) throw new AppError("VALIDATION_ERROR", "Check-in time cannot be in the future", 422);
    if (checkOutAt && (!checkInAt || checkOutAt <= checkInAt || checkOutAt > new Date())) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in and not in the future", 422);
  } else if (checkInAt || checkOutAt) throw new AppError("VALIDATION_ERROR", "Check-in/out times apply only to present attendance", 422);

  const after = { status: input.status, checkInAt, checkOutAt, reason: input.reason };
  const { adjustment, before } = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(attendanceAdjustments)
      .where(and(eq(attendanceAdjustments.organizationId, organizationId), eq(attendanceAdjustments.employeeId, targetId), eq(attendanceAdjustments.attendanceDate, input.attendanceDate)))
      .limit(1)
      .for("update");
    const before = existing ? { status: existing.status, checkInAt: existing.checkInAt, checkOutAt: existing.checkOutAt, reason: existing.reason } : null;
    const entry = historyEntry(before, after, actor.userId);
    if (existing) {
      const photoAssetIds = input.photoAssetId && !existing.photoAssetIds.includes(input.photoAssetId) ? [...existing.photoAssetIds, input.photoAssetId] : existing.photoAssetIds;
      const [row] = await tx.update(attendanceAdjustments).set({ ...after, adjustedBy: actor.userId, photoAssetIds, history: [...existing.history, entry] })
        .where(eq(attendanceAdjustments.id, existing.id)).returning();
      return { adjustment: row, before };
    }
    const [row] = await tx.insert(attendanceAdjustments).values({
      organizationId,
      employeeId: targetId,
      ...(profile ? { workforceEmployeeId: profile.id } : {}),
      attendanceDate: input.attendanceDate,
      ...after,
      adjustedBy: actor.userId,
      photoAssetIds: input.photoAssetId ? [input.photoAssetId] : [],
      history: [entry],
    }).returning();
    return { adjustment: row, before };
  });
  const employeeName = employee?.name ?? `${profile!.firstName} ${profile!.lastName}`.trim();
  const employeeEmail = employee?.email ?? profile!.email;
  await recordAudit({ actor, action: "attendance.manually_adjusted", entityType: "attendance_adjustment", entityId: adjustment.id, organizationId, before, after: { ...after, employeeId: targetId, workforceEmployeeId: profile?.id ?? null, attendanceDate: input.attendanceDate }, reason: input.reason, meta });
  return { id: adjustment.id, employeeId: targetId, employee: { name: employeeName, email: employeeEmail }, attendanceDate: adjustment.attendanceDate, ...after, adjustedBy: actor.userId };
}

export async function recordGuardPunch(actor: AuthContext, organizationId: string, input: GuardPunchInput, meta: RequestMeta) {
  const organization = await assertTenantAccessible(organizationId);
  const { office, punch } = await validatePunch(actor, organizationId, input, input.officeLocationId ?? "", new Date());
  const [profile] = await db.select().from(workforceEmployees).where(and(
    eq(workforceEmployees.organizationId, organizationId),
    eq(workforceEmployees.status, "active"),
    or(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.userId, input.employeeId)),
  )).limit(1);
  const employee = profile?.userId
    ? await findActiveUser(organizationId, profile.userId, false)
    : await findActiveUser(organizationId, input.employeeId, true);
  if (!employee && !profile) throw new AppError("NOT_FOUND", "Active employee profile was not found", 404);
  const attendanceDate = dateForTimezone(new Date(), organization.timezone);
  const targetEmployeeId = (employee?.id ?? profile?.id)!;
  const adjustmentFilter = profile
    ? and(eq(attendanceAdjustments.organizationId, organizationId), eq(attendanceAdjustments.attendanceDate, attendanceDate), or(eq(attendanceAdjustments.workforceEmployeeId, profile.id), eq(attendanceAdjustments.employeeId, targetEmployeeId)))
    : and(eq(attendanceAdjustments.organizationId, organizationId), eq(attendanceAdjustments.employeeId, targetEmployeeId), eq(attendanceAdjustments.attendanceDate, attendanceDate));
  const [current] = await db.select().from(attendanceAdjustments).where(adjustmentFilter).limit(1);
  const now = new Date().toISOString();
  const location = { latitude: punch.latitude, longitude: punch.longitude, gpsAccuracyM: punch.gpsAccuracyM, officeDistanceM: punch.officeDistanceM, locationVerification: punch.locationVerification } as PunchLocation;

  /** Writes the adjustment (update when it exists, insert otherwise) and returns the row. */
  const save = async (existing: AttendanceAdjustmentRow | undefined, values: Partial<typeof attendanceAdjustments.$inferInsert> & { history: AdjustmentHistoryEntry[]; photoAssetIds: string[] }, insertBase: { employeeId: string; workforceEmployeeId?: string }) => {
    if (existing) {
      const [row] = await db.update(attendanceAdjustments).set(values).where(eq(attendanceAdjustments.id, existing.id)).returning();
      return row;
    }
    const [row] = await db.insert(attendanceAdjustments).values({
      organizationId, attendanceDate, adjustedBy: actor.userId, status: "present", reason: "", ...insertBase, ...values,
    } as typeof attendanceAdjustments.$inferInsert).returning();
    return row;
  };

  if (profile) {
    const checkInAt = input.action === "check_in" ? new Date(now) : current?.checkInAt ?? null;
    const checkOutAt = input.action === "check_out" ? new Date(now) : current?.checkOutAt ?? null;
    if (input.action === "check_in" && current?.checkInAt) throw new AppError("INVALID_STATE", "This employee already has a check-in recorded for today.", 409);
    if (input.action === "check_out" && !current?.checkInAt) throw new AppError("INVALID_STATE", "Record a check-in before checking this employee out.", 409);
    if (input.action === "check_out" && current?.checkOutAt) throw new AppError("INVALID_STATE", "This employee already has a check-out recorded for today.", 409);
    const reason = input.action === "check_in" ? "Mobile guard check-in" : "Mobile guard check-out";
    const before = current ? { status: current.status, checkInAt: current.checkInAt, checkOutAt: current.checkOutAt, reason: current.reason } : null;
    const after = { status: "present" as const, checkInAt, checkOutAt, reason };
    const existingPhotos = current?.photoAssetIds ?? [];
    const adjustment = await save(current, {
      ...after,
      adjustedBy: actor.userId,
      photoAssetIds: existingPhotos.includes(input.photoAssetId) ? existingPhotos : [...existingPhotos, input.photoAssetId],
      officeLocationId: office?.id ?? null,
      ...(input.action === "check_in" ? { checkInLocation: location } : { checkOutLocation: location }),
      history: [...(current?.history ?? []), historyEntry(before, after, actor.userId)],
    }, { employeeId: targetEmployeeId, workforceEmployeeId: profile.id });
    await recordAudit({ actor, action: `attendance.guard_${input.action}`, entityType: "attendance_adjustment", entityId: adjustment.id, organizationId, before, after: { ...after, workforceEmployeeId: profile.id, attendanceDate }, meta });
    return { id: adjustment.id, employeeId: profile.id, employee: { name: `${profile.firstName} ${profile.lastName}`.trim(), email: profile.email }, attendanceDate, ...after, adjustedBy: actor.userId };
  }
  if (input.action === "check_in") {
    if (current?.checkInAt) throw new AppError("INVALID_STATE", "This employee already has a check-in recorded for today.", 409);
    const after = { status: "present" as const, checkInAt: new Date(now), checkOutAt: null, reason: "Mobile guard check-in" };
    // The former implementation captured `before` after applying the new values to the existing document,
    // so an existing adjustment's history "before" mirrors the new values; kept identical.
    const before = current ? { status: after.status, checkInAt: after.checkInAt, checkOutAt: null, reason: after.reason } : null;
    const adjustment = await save(current, {
      ...after,
      officeLocationId: office?.id ?? null,
      checkInLocation: location,
      adjustedBy: actor.userId,
      photoAssetIds: [...(current?.photoAssetIds ?? []), input.photoAssetId],
      history: [...(current?.history ?? []), historyEntry(before, after, actor.userId)],
    }, { employeeId: employee!.id });
    await recordAudit({ actor, action: "attendance.guard_check_in", entityType: "attendance_adjustment", entityId: adjustment.id, organizationId, after: { attendanceDate, officeLocationId: office?.id ?? null }, meta });
    return { id: adjustment.id, employeeId: employee!.id, employee: { name: employee!.name, email: employee!.email }, attendanceDate, ...after, adjustedBy: actor.userId };
  }
  if (!current?.checkInAt) throw new AppError("INVALID_STATE", "Record a check-in before checking this employee out.", 409);
  if (current.checkOutAt) throw new AppError("INVALID_STATE", "This employee already has a check-out recorded for today.", 409);
  const after = { status: "present" as const, checkInAt: current.checkInAt, checkOutAt: new Date(now), reason: "Mobile guard check-out" };
  // As before: the history "before" snapshot was taken after the new status/reason were applied.
  const before = { status: after.status, checkInAt: current.checkInAt, checkOutAt: null, reason: after.reason };
  const adjustment = await save(current, {
    ...after,
    officeLocationId: office?.id ?? current.officeLocationId ?? null,
    checkOutLocation: location,
    adjustedBy: actor.userId,
    photoAssetIds: [...current.photoAssetIds, input.photoAssetId],
    history: [...current.history, historyEntry(before, after, actor.userId)],
  }, { employeeId: employee!.id });
  await recordAudit({ actor, action: "attendance.guard_check_out", entityType: "attendance_adjustment", entityId: adjustment.id, organizationId, after: { attendanceDate, officeLocationId: office?.id ?? null }, meta });
  return { id: adjustment.id, employeeId: employee!.id, employee: { name: employee!.name, email: employee!.email }, attendanceDate, ...after, adjustedBy: actor.userId };
}

export async function createCorrectionRequest(actor: AuthContext, organizationId: string, input: CorrectionInput, meta: RequestMeta) {
  const policy = await findPolicy(organizationId);
  if (policy?.correctionRequestsEnabled === false) throw new AppError("FEATURE_DISABLED", "Attendance correction requests are disabled", 403);
  const [record] = await db.select().from(attendanceRecords)
    .where(and(eq(attendanceRecords.id, input.attendanceRecordId), eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.employeeId, actor.userId)))
    .limit(1);
  if (!record?.checkIn) throw new AppError("NOT_FOUND", "Your attendance record was not found", 404);
  if (await adjustmentExists(organizationId, actor.userId, record.attendanceDate)) throw new AppError("INVALID_STATE", "This attendance was manually adjusted by an administrator. Contact them for further changes.", 409);
  const requestedCheckInAt = input.requestedCheckInAt ? new Date(input.requestedCheckInAt) : null;
  const requestedCheckOutAt = input.requestedCheckOutAt ? new Date(input.requestedCheckOutAt) : null;
  const proposedCheckIn = requestedCheckInAt ?? new Date(record.checkIn.at);
  const existingCheckOut = record.checkOut?.at ? new Date(record.checkOut.at) : record.correctedCheckOutAt ?? null;
  const proposedCheckOut = requestedCheckOutAt ?? existingCheckOut;
  const organization = await assertTenantAccessible(organizationId);
  const isSameAttendanceDate = (date: Date) => dateForTimezone(date, organization.timezone) === record.attendanceDate;
  if (requestedCheckInAt && (requestedCheckInAt > new Date() || !isSameAttendanceDate(requestedCheckInAt))) throw new AppError("VALIDATION_ERROR", "Corrected check-in must be on the attendance date and not in the future", 422);
  if (requestedCheckOutAt && (requestedCheckOutAt > new Date() || !isSameAttendanceDate(requestedCheckOutAt))) throw new AppError("VALIDATION_ERROR", "Corrected check-out must be on the attendance date and not in the future", 422);
  if (proposedCheckOut && proposedCheckOut <= proposedCheckIn) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in", 422);
  const evidence = input.evidenceFileAssetId
    ? (await db.select({ id: fileAssets.id }).from(fileAssets).where(and(eq(fileAssets.id, input.evidenceFileAssetId), eq(fileAssets.organizationId, organizationId), eq(fileAssets.uploadedBy, actor.userId))).limit(1))[0] ?? null
    : null;
  if (input.evidenceFileAssetId && !evidence) throw new AppError("NOT_FOUND", "Correction evidence was not found", 404);
  const [existing] = await db.select({ id: attendanceCorrections.id }).from(attendanceCorrections)
    .where(and(eq(attendanceCorrections.organizationId, organizationId), eq(attendanceCorrections.attendanceRecordId, record.id), eq(attendanceCorrections.status, "pending")))
    .limit(1);
  if (existing) throw new AppError("CONFLICT", "A correction request is already pending for this attendance", 409);
  const [correction] = await db.insert(attendanceCorrections).values({ organizationId, attendanceRecordId: record.id, employeeId: actor.userId, requestedCheckInAt, requestedCheckOutAt, reason: input.reason.trim(), evidenceFileAssetId: evidence?.id ?? null }).returning();
  await recordAudit({ actor, action: "attendance.correction_requested", entityType: "attendance_correction", entityId: correction.id, organizationId, after: { attendanceRecordId: record.id, requestedCheckInAt, requestedCheckOutAt, reason: input.reason }, meta });
  return presentCorrection(correction);
}

function presentCorrection(correction: AttendanceCorrectionRow) {
  return { id: correction.id, attendanceRecordId: correction.attendanceRecordId, employeeId: correction.employeeId, requestedCheckInAt: correction.requestedCheckInAt ?? null, requestedCheckOutAt: correction.requestedCheckOutAt ?? null, reason: correction.reason, evidenceFileAssetId: correction.evidenceFileAssetId ?? null, status: correction.status, reviewedBy: correction.reviewedBy ?? null, reviewedAt: correction.reviewedAt ?? null, reviewComment: correction.reviewComment ?? "", createdAt: correction.createdAt };
}

async function correctionRecordMap(organizationId: string, corrections: AttendanceCorrectionRow[]) {
  const recordIds = [...new Set(corrections.map((correction) => correction.attendanceRecordId))];
  const records = recordIds.length
    ? await db.select({ id: attendanceRecords.id, attendanceDate: attendanceRecords.attendanceDate, checkIn: attendanceRecords.checkIn, checkOut: attendanceRecords.checkOut, correctedCheckOutAt: attendanceRecords.correctedCheckOutAt })
      .from(attendanceRecords).where(and(inArray(attendanceRecords.id, recordIds), eq(attendanceRecords.organizationId, organizationId)))
    : [];
  return new Map(records.map((record) => [record.id, { attendanceDate: record.attendanceDate, currentCheckInAt: record.checkIn?.at ?? null, currentCheckOutAt: record.checkOut?.at ?? record.correctedCheckOutAt ?? null }]));
}

export async function listCorrections(organizationId: string, query: CorrectionQuery) {
  const where = and(eq(attendanceCorrections.organizationId, organizationId), query.status ? eq(attendanceCorrections.status, query.status) : undefined);
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    db.select().from(attendanceCorrections).where(where).orderBy(desc(attendanceCorrections.createdAt)).limit(query.limit).offset(skip),
    db.$count(attendanceCorrections, where),
  ]);
  const employeeIds = [...new Set(corrections.map((correction) => correction.employeeId))];
  const [employees, recordMap] = await Promise.all([
    employeeIds.length ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(inArray(users.id, employeeIds), eq(users.organizationId, organizationId))) : Promise.resolve([]),
    correctionRecordMap(organizationId, corrections),
  ]);
  const employeeMap = new Map(employees.map((employee) => [employee.id, { name: employee.name, email: employee.email }]));
  return { items: corrections.map((correction) => ({ ...presentCorrection(correction), ...recordMap.get(correction.attendanceRecordId), employee: employeeMap.get(correction.employeeId) ?? null })), meta: { page: query.page, limit: query.limit, total } };
}

export async function listEmployeeCorrections(actor: AuthContext, organizationId: string, query: CorrectionQuery) {
  const where = and(eq(attendanceCorrections.organizationId, organizationId), eq(attendanceCorrections.employeeId, actor.userId), query.status ? eq(attendanceCorrections.status, query.status) : undefined);
  const skip = (query.page - 1) * query.limit;
  const [corrections, total] = await Promise.all([
    db.select().from(attendanceCorrections).where(where).orderBy(desc(attendanceCorrections.createdAt)).limit(query.limit).offset(skip),
    db.$count(attendanceCorrections, where),
  ]);
  const recordMap = await correctionRecordMap(organizationId, corrections);
  return { items: corrections.map((correction) => ({ ...presentCorrection(correction), ...recordMap.get(correction.attendanceRecordId) })), meta: { page: query.page, limit: query.limit, total } };
}

export async function reviewCorrection(actor: AuthContext, organizationId: string, correctionId: string, input: CorrectionReview, meta: RequestMeta) {
  const [correction] = await db.select().from(attendanceCorrections)
    .where(and(eq(attendanceCorrections.id, correctionId), eq(attendanceCorrections.organizationId, organizationId), eq(attendanceCorrections.status, "pending")))
    .limit(1);
  if (!correction) throw new AppError("NOT_FOUND", "Pending correction request not found", 404);
  const [record] = await db.select().from(attendanceRecords)
    .where(and(eq(attendanceRecords.id, correction.attendanceRecordId), eq(attendanceRecords.organizationId, organizationId), eq(attendanceRecords.employeeId, correction.employeeId)))
    .limit(1);
  if (!record?.checkIn) throw new AppError("INVALID_STATE", "Attendance record cannot accept this correction", 409);
  const recordCheckInAt = new Date(record.checkIn.at);
  const before = { status: record.status, checkInAt: recordCheckInAt, checkOutAt: record.checkOut?.at ? new Date(record.checkOut.at) : null, correctedCheckOutAt: record.correctedCheckOutAt ?? null };
  const correctionChanges = { status: input.decision, reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: input.comment } as Partial<typeof attendanceCorrections.$inferInsert>;
  let recordStatus = record.status;
  let recordChanges: Partial<typeof attendanceRecords.$inferInsert> | null = null;
  if (input.decision === "approved") {
    const policy = await findPolicy(organizationId);
    const changes: Record<string, unknown> = {};
    let checkIn: Punch = record.checkIn;
    let checkOut: Punch | null = record.checkOut;
    let correctedCheckOutAt = record.correctedCheckOutAt;
    recordChanges = {};
    if (correction.requestedCheckInAt) {
      changes.checkInAt = { before: recordCheckInAt, after: correction.requestedCheckInAt };
      checkIn = { ...checkIn, at: correction.requestedCheckInAt.toISOString() };
      recordChanges.checkIn = checkIn;
    }
    if (correction.requestedCheckOutAt) {
      const priorCheckOutAt = checkOut?.at ? new Date(checkOut.at) : correctedCheckOutAt ?? null;
      changes.checkOutAt = { before: priorCheckOutAt, after: correction.requestedCheckOutAt };
      if (checkOut) { checkOut = { ...checkOut, at: correction.requestedCheckOutAt.toISOString() }; recordChanges.checkOut = checkOut; }
      else { correctedCheckOutAt = correction.requestedCheckOutAt; recordChanges.correctedCheckOutAt = correctedCheckOutAt; }
      recordChanges.correctionId = correction.id;
      recordChanges.status = "completed";
      recordStatus = "completed";
    }
    const effectiveCheckOutAt = checkOut?.at ? new Date(checkOut.at) : correctedCheckOutAt ?? null;
    if (effectiveCheckOutAt) {
      const organization = await assertTenantAccessible(organizationId);
      const profileId = await findActiveProfileIdForUser(organizationId, record.employeeId);
      const assignedShift = profileId ? await getEffectiveShiftForDate(organizationId, profileId, record.attendanceDate) : null;
      const workingResult = calculateWorkingMinutes(new Date(checkIn.at), effectiveCheckOutAt, assignedShift, record.attendanceDate, organization.timezone);
      recordChanges.totalWorkingMinutes = workingResult.totalWorkingMinutes;
      recordChanges.unpaidBreakMinutes = workingResult.unpaidBreakMinutes;
      recordChanges.halfDay = workingResult.totalWorkingMinutes < halfDayThresholdMinutes(policy, assignedShift);
    }
    correctionChanges.appliedChange = { fields: changes, approvedBy: actor.userId, reason: correction.reason };
  }
  const updatedCorrection = await db.transaction(async (tx) => {
    const [updated] = await tx.update(attendanceCorrections).set(correctionChanges)
      .where(and(eq(attendanceCorrections.id, correction.id), eq(attendanceCorrections.status, "pending")))
      .returning();
    if (!updated) throw new AppError("NOT_FOUND", "Pending correction request not found", 404);
    if (recordChanges && Object.keys(recordChanges).length) await tx.update(attendanceRecords).set(recordChanges).where(eq(attendanceRecords.id, record.id));
    return updated;
  });
  await recordAudit({ actor, action: `attendance.correction_${input.decision}`, entityType: "attendance_correction", entityId: updatedCorrection.id, organizationId, before, after: { status: recordStatus, correctionStatus: updatedCorrection.status, requestedCheckInAt: updatedCorrection.requestedCheckInAt, requestedCheckOutAt: updatedCorrection.requestedCheckOutAt, reviewComment: updatedCorrection.reviewComment }, reason: input.comment || correction.reason, meta });
  return presentCorrection(updatedCorrection);
}
