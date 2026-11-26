import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { isDuplicateKey } from "../../common/utils/mongo.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { UserModel } from "../users/user.model.js";
import { OfficeLocationModel } from "../attendance/office-location.model.js";
import { AttendanceRecordModel } from "../attendance/attendance-record.model.js";
import { AttendanceAdjustmentModel } from "../attendance/attendance-adjustment.model.js";
import { AttendancePolicyModel } from "../attendance/attendance-policy.model.js";
import { WorkforceEmployeeModel } from "./employee.model.js";
import { DepartmentModel } from "./department.model.js";
import { DesignationModel } from "./designation.model.js";
import { ShiftModel } from "./shift.model.js";
import { ShiftAssignmentModel } from "./shift-assignment.model.js";
import { ShiftSwapModel } from "./shift-swap.model.js";
import { CompensationComponentModel, PayStructureModel, CompensationAssignmentModel, DailyEarningModel } from "./compensation.model.js";
import { OvertimePolicyModel, OvertimeEntryModel } from "./overtime.model.js";
import { PayrollRunModel } from "./payroll-run.model.js";
import { calculateAttendanceBaseMinor, calculateDailyAmountMinor, calculateOvertimeAmountMinor, calculatePercentageMinor, calculateProRataMinor } from "./payroll-calculations.js";
import { LeaveRequestModel } from "./leave.model.js";
import { accessibleWorkforceEmployeeIds, assertWorkforceAssignmentWithinScope, assertWorkforceEmployeeAccessible, workforceEmployeeScopeFilter } from "./data-scope.js";
import type { compensationAssignmentSchema, componentSchema, dailyEarningCreateSchema, dailyEarningReviewSchema, departmentSchema, designationSchema, employeeCreateSchema, employeeUpdateSchema, overtimeCreateSchema, overtimePolicySchema, payStructureSchema, payrollPaymentSchema, payrollPeriodSchema, payrollRevisionSchema, shiftAssignmentSchema, shiftSchema, shiftSwapCreateSchema, shiftSwapReviewSchema, workforceListSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type EmployeeInput = z.infer<typeof employeeCreateSchema>;
type EmployeeUpdate = z.infer<typeof employeeUpdateSchema>;
type ListInput = z.infer<typeof workforceListSchema>;

function dayBefore(date: string) { const value = new Date(`${date}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); }

function prorateMonthlyRateByWorkdays(amountMinor: number, start: string, end: string, weeklyOffs: number[]) {
  let cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  let total = 0;
  while (cursor <= last) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const segmentEnd = monthEnd < last ? monthEnd : last;
    const fullMonthWorkdays = Math.max(1, monthEnd.getUTCDate() - Array.from({ length: monthEnd.getUTCDate() }, (_, index) => index + 1).filter((day) => weeklyOffs.includes(new Date(Date.UTC(year, month, day)).getUTCDay())).length);
    let segmentWorkdays = 0;
    while (cursor <= segmentEnd) {
      if (!weeklyOffs.includes(cursor.getUTCDay())) segmentWorkdays++;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    total += calculateProRataMinor(amountMinor, segmentWorkdays, fullMonthWorkdays);
    cursor = new Date(Date.UTC(year, month + 1, 1));
    if (cursor < monthStart) break;
  }
  return total;
}

async function validateRelations(orgId: string, input: Partial<EmployeeInput>, employeeId?: string) {
  const checks: Promise<unknown>[] = [];
  if (input.userId) checks.push(UserModel.exists({ _id: input.userId, organizationId: orgId }));
  if (input.userId) checks.push(WorkforceEmployeeModel.exists({ organizationId: orgId, userId: input.userId, ...(employeeId ? { _id: { $ne: employeeId } } : {}) }).then((linked) => !linked));
  if (input.departmentId) checks.push(DepartmentModel.exists({ _id: input.departmentId, organizationId: orgId }));
  if (input.designationId) checks.push(DesignationModel.exists({ _id: input.designationId, organizationId: orgId }));
  if (input.reportingManagerId) checks.push(WorkforceEmployeeModel.exists({ _id: input.reportingManagerId, organizationId: orgId }));
  if (input.workLocationId) checks.push(OfficeLocationModel.exists({ _id: input.workLocationId, organizationId: orgId }));
  const results = await Promise.all(checks);
  if (results.some((result) => !result)) throw new AppError("VALIDATION_ERROR", "A linked employee, department, designation, user, or location was not found in this organization", 422);
}

function employeeView(employee: any) {
  return { id: employee._id.toString(), organizationId: employee.organizationId.toString(), userId: employee.userId?.toString() ?? null,
    employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName, name: `${employee.firstName} ${employee.lastName}`.trim(),
    email: employee.email, phone: employee.phone, dateOfBirth: employee.dateOfBirth, joiningDate: employee.joiningDate, employmentType: employee.employmentType,
    status: employee.status, departmentId: employee.departmentId?.toString() ?? null, designationId: employee.designationId?.toString() ?? null,
    reportingManagerId: employee.reportingManagerId?.toString() ?? null, workLocationId: employee.workLocationId?.toString() ?? null, notes: employee.notes,
    createdAt: employee.createdAt, updatedAt: employee.updatedAt };
}

export async function listWorkforceEmployees(actor: AuthContext, orgId: string, query: ListInput) {
  const filter: Record<string, unknown> = { organizationId: orgId, ...workforceEmployeeScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.departmentId) filter.departmentId = query.departmentId;
  if (query.employmentType) filter.employmentType = query.employmentType;
  if (query.search) filter.$or = ["employeeNumber", "firstName", "lastName", "email", "phone"].map((key) => ({ [key]: { $regex: query.search, $options: "i" } }));
  const [items, total] = await Promise.all([WorkforceEmployeeModel.find(filter).sort({ lastName: 1, firstName: 1 }).skip((query.page - 1) * query.limit).limit(query.limit), WorkforceEmployeeModel.countDocuments(filter)]);
  return { items: items.map(employeeView), meta: { page: query.page, limit: query.limit, total } };
}

export async function listWorkforceLoginAccounts(actor: AuthContext, orgId: string) {
  const [users, links] = await Promise.all([
    // Any team member login (not only the `employee` role) can be linked to an employee profile.
    // Linked accounts are always returned, even if disabled, so the edit form can show the current link.
    WorkforceEmployeeModel.distinct("userId", { organizationId: orgId, userId: { $ne: null } }).then((linkedIds) => {
      const filter: Record<string, unknown> = { organizationId: orgId, role: { $in: TEAM_MEMBER_ROLES }, $or: [{ status: "active" }, { _id: { $in: linkedIds } }] };
      return UserModel.find(filter).select("name email role status").sort({ name: 1 }).lean();
    }),
    WorkforceEmployeeModel.find({ organizationId: orgId, userId: { $ne: null } }).select("_id userId").lean(),
  ]);
  const scope = workforceEmployeeScopeFilter(actor);
  const scopedLinks = Object.keys(scope).length ? await WorkforceEmployeeModel.find({ organizationId: orgId, userId: { $ne: null }, ...scope }).select("_id userId").lean() : links;
  const visibleUserIds = new Set(scopedLinks.map((item) => item.userId!.toString()));
  const linkedEmployeeByUser = new Map(scopedLinks.map((item) => [item.userId!.toString(), item._id.toString()]));
  return users.filter((user) => !Object.keys(scope).length || visibleUserIds.has(user._id.toString())).map((user) => ({ id: user._id.toString(), name: user.name, email: user.email, role: user.role, status: user.status, linkedEmployeeId: linkedEmployeeByUser.get(user._id.toString()) ?? null }));
}

const TEAM_MEMBER_ROLES = ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee", "guard"];

/**
 * Converts existing team members (organization login accounts) into employee profiles.
 * Members already linked to a profile, or whose email already belongs to a profile, are skipped.
 * The login account email becomes the employee email and the account is linked to the new profile.
 */
export async function importTeamMembersAsEmployees(actor: AuthContext, orgId: string, meta: RequestMeta) {
  if (Object.keys(workforceEmployeeScopeFilter(actor)).length) throw new AppError("FORBIDDEN", "Importing all team members requires organization-wide workforce access", 403);
  const [users, profiles] = await Promise.all([
    UserModel.find({ organizationId: orgId, status: "active", role: { $in: TEAM_MEMBER_ROLES } } as Record<string, unknown>).select("name email createdAt").sort({ createdAt: 1 }).lean(),
    WorkforceEmployeeModel.find({ organizationId: orgId }).select("userId email employeeNumber").lean(),
  ]);
  const linkedUserIds = new Set(profiles.filter((item) => item.userId).map((item) => item.userId!.toString()));
  const profileEmails = new Set(profiles.map((item) => (item.email ?? "").toLowerCase()).filter(Boolean));
  const usedNumbers = new Set(profiles.map((item) => item.employeeNumber.toUpperCase()));
  let sequence = profiles.length;
  const nextNumber = () => { let candidate; do { sequence += 1; candidate = `EMP${String(sequence).padStart(4, "0")}`; } while (usedNumbers.has(candidate)); usedNumbers.add(candidate); return candidate; };
  const toCreate = [];
  let skipped = 0;
  for (const member of users) {
    const email = (member.email ?? "").toLowerCase();
    if (linkedUserIds.has(member._id.toString()) || (email && profileEmails.has(email))) { skipped++; continue; }
    const [firstName, ...rest] = (member.name || email.split("@")[0] || "Employee").trim().split(/\s+/);
    toCreate.push({ organizationId: new Types.ObjectId(orgId), userId: member._id, employeeNumber: nextNumber(), firstName, lastName: rest.join(" "), email, joiningDate: new Date((member as any).createdAt ?? Date.now()).toISOString().slice(0, 10), employmentType: "permanent", status: "active" });
  }
  const created = toCreate.length ? await WorkforceEmployeeModel.insertMany(toCreate, { ordered: false }) : [];
  if (created.length) await recordAudit({ actor, action: "workforce.team_members_imported", entityType: "workforce_employee_import", entityId: orgId, organizationId: orgId, after: { createdCount: created.length, skippedCount: skipped, employeeNumbers: created.map((item) => item.employeeNumber) }, meta });
  return { createdCount: created.length, skippedCount: skipped };
}

export async function listPayrollEmployees(actor: AuthContext, orgId: string, query: ListInput) {
  const filter: Record<string, unknown> = { organizationId: orgId, ...workforceEmployeeScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.search) filter.$or = ["employeeNumber", "firstName", "lastName"].map((key) => ({ [key]: { $regex: query.search, $options: "i" } }));
  const [items, total] = await Promise.all([WorkforceEmployeeModel.find(filter).select("employeeNumber firstName lastName status").sort({ lastName: 1, firstName: 1 }).skip((query.page - 1) * query.limit).limit(query.limit), WorkforceEmployeeModel.countDocuments(filter)]);
  return { items: items.map((item) => ({ id: item._id.toString(), employeeNumber: item.employeeNumber, name: `${item.firstName} ${item.lastName}`.trim(), status: item.status })), meta: { page: query.page, limit: query.limit, total } };
}

export async function createWorkforceEmployee(actor: AuthContext, orgId: string, input: EmployeeInput, meta: RequestMeta) {
  if (input.reportingManagerId) await assertWorkforceEmployeeAccessible(orgId, actor, input.reportingManagerId);
  assertWorkforceAssignmentWithinScope(actor, input.departmentId, input.workLocationId);
  await validateRelations(orgId, input);
  let employee;
  try {
    employee = await WorkforceEmployeeModel.create({ ...input, organizationId: new Types.ObjectId(orgId) });
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("CONFLICT", `Employee ID ${input.employeeNumber.toUpperCase()} is already in use. Enter a unique employee ID.`, 409);
    throw error;
  }
  await recordAudit({ actor, action: "workforce.employee_created", entityType: "workforce_employee", entityId: employee._id.toString(), organizationId: orgId, after: employeeView(employee), meta });
  return employeeView(employee);
}

export async function updateWorkforceEmployee(actor: AuthContext, orgId: string, id: string, input: EmployeeUpdate, meta: RequestMeta) {
  await validateRelations(orgId, input, id);
  await assertWorkforceEmployeeAccessible(orgId, actor, id);
  const employee = await WorkforceEmployeeModel.findOne({ _id: id, organizationId: orgId });
  if (!employee) throw new AppError("NOT_FOUND", "Employee profile not found", 404);
  assertWorkforceAssignmentWithinScope(actor, input.departmentId ?? employee.departmentId?.toString(), input.workLocationId ?? employee.workLocationId?.toString());
  const before = employeeView(employee);
  Object.assign(employee, input);
  await employee.save();
  await recordAudit({ actor, action: "workforce.employee_updated", entityType: "workforce_employee", entityId: id, organizationId: orgId, before, after: employeeView(employee), meta });
  return employeeView(employee);
}

export async function listDepartments(orgId: string) { return DepartmentModel.find({ organizationId: orgId }).sort({ name: 1 }).lean(); }
export async function saveDepartment(actor: AuthContext, orgId: string, input: z.infer<typeof departmentSchema>, id: string | undefined, meta: RequestMeta) {
  if (input.managerEmployeeId && !await WorkforceEmployeeModel.exists({ _id: input.managerEmployeeId, organizationId: orgId })) throw new AppError("NOT_FOUND", "Department manager was not found", 404);
  const record = id ? await DepartmentModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: input }, { new: true, runValidators: true }) : await DepartmentModel.create({ ...input, organizationId: orgId });
  if (!record) throw new AppError("NOT_FOUND", "Department not found", 404);
  await recordAudit({ actor, action: id ? "workforce.department_updated" : "workforce.department_created", entityType: "department", entityId: record._id.toString(), organizationId: orgId, after: input, meta });
  return { id: record._id.toString(), name: record.name, code: record.code, managerEmployeeId: record.managerEmployeeId?.toString() ?? null, status: record.status };
}

export async function listDesignations(orgId: string) { return DesignationModel.find({ organizationId: orgId }).sort({ name: 1 }).lean(); }
export async function saveDesignation(actor: AuthContext, orgId: string, input: z.infer<typeof designationSchema>, id: string | undefined, meta: RequestMeta) {
  const record = id ? await DesignationModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: input }, { new: true, runValidators: true }) : await DesignationModel.create({ ...input, organizationId: orgId });
  if (!record) throw new AppError("NOT_FOUND", "Designation not found", 404);
  await recordAudit({ actor, action: id ? "workforce.designation_updated" : "workforce.designation_created", entityType: "designation", entityId: record._id.toString(), organizationId: orgId, after: input, meta });
  return { id: record._id.toString(), name: record.name, description: record.description, status: record.status };
}

export async function listShifts(_actor: AuthContext, orgId: string, section: "shifts" | "assignments" | "assignment-form" | "all" = "all") {
  const [shifts, assignments] = await Promise.all([
    section === "shifts" || section === "assignment-form" || section === "all" ? ShiftModel.find({ organizationId: orgId }).sort({ effectiveFrom: -1, name: 1 }).lean() : Promise.resolve([]),
    section === "assignments" || section === "assignment-form" || section === "all" ? ShiftAssignmentModel.find({ organizationId: orgId, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: new Date().toISOString().slice(0, 10) } }] }).populate("employeeId", "employeeNumber firstName lastName").populate("shiftId", "name").sort({ effectiveFrom: -1 }).lean() : Promise.resolve([]),
  ]);
  return { shifts: shifts.map((shift) => ({ id: shift._id.toString(), name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: shift.crossesMidnight, flexibleWindowMinutes: shift.flexibleWindowMinutes, breaks: shift.breaks, weeklyOffs: shift.weeklyOffs, effectiveFrom: shift.effectiveFrom, effectiveTo: shift.effectiveTo, status: shift.status })), assignments: assignments.map((item: any) => ({ id: item._id.toString(), employee: item.employeeId, shift: item.shiftId, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo })) };
}

export async function createShift(actor: AuthContext, orgId: string, input: z.infer<typeof shiftSchema>, meta: RequestMeta) {
  const start = Number(input.startTime.slice(0, 2)) * 60 + Number(input.startTime.slice(3));
  const end = Number(input.endTime.slice(0, 2)) * 60 + Number(input.endTime.slice(3));
  const crossesMidnight = end <= start;
  const shiftEnd = end + (crossesMidnight ? 1440 : 0);
  for (const item of input.breaks) {
    const breakStart = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3));
    let breakEnd = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3));
    if (breakEnd <= breakStart) breakEnd += 1440;
    const normalizedStart = breakStart < start && crossesMidnight ? breakStart + 1440 : breakStart;
    const normalizedEnd = breakEnd < start && crossesMidnight ? breakEnd + 1440 : breakEnd;
    if (normalizedStart < start || normalizedEnd > shiftEnd) throw new AppError("VALIDATION_ERROR", `Break "${item.name}" must fit within the shift`, 422);
  }
  const shift = await ShiftModel.create({ ...input, crossesMidnight, organizationId: orgId });
  await recordAudit({ actor, action: "workforce.shift_created", entityType: "workforce_shift", entityId: shift._id.toString(), organizationId: orgId, after: input, meta });
  return { id: shift._id.toString(), name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: shift.crossesMidnight, breaks: shift.breaks, weeklyOffs: shift.weeklyOffs, effectiveFrom: shift.effectiveFrom, effectiveTo: shift.effectiveTo, status: shift.status };
}

export async function updateShift(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof shiftSchema>, meta: RequestMeta) {
  const start = Number(input.startTime.slice(0, 2)) * 60 + Number(input.startTime.slice(3));
  const end = Number(input.endTime.slice(0, 2)) * 60 + Number(input.endTime.slice(3));
  const crossesMidnight = end <= start;
  const shiftEnd = end + (crossesMidnight ? 1440 : 0);
  for (const item of input.breaks) {
    const breakStart = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3));
    let breakEnd = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3));
    if (breakEnd <= breakStart) breakEnd += 1440;
    const normalizedStart = breakStart < start && crossesMidnight ? breakStart + 1440 : breakStart;
    const normalizedEnd = breakEnd < start && crossesMidnight ? breakEnd + 1440 : breakEnd;
    if (normalizedStart < start || normalizedEnd > shiftEnd) throw new AppError("VALIDATION_ERROR", `Break "${item.name}" must fit within the shift`, 422);
  }
  const shift = await ShiftModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: { ...input, crossesMidnight } }, { new: true, runValidators: true });
  if (!shift) throw new AppError("NOT_FOUND", "Shift not found", 404);
  await recordAudit({ actor, action: "workforce.shift_updated", entityType: "workforce_shift", entityId: id, organizationId: orgId, after: input, meta });
  return { id, name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: shift.crossesMidnight, breaks: shift.breaks, weeklyOffs: shift.weeklyOffs, effectiveFrom: shift.effectiveFrom, effectiveTo: shift.effectiveTo, status: shift.status };
}

export async function deleteShift(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const shift = await ShiftModel.findOne({ _id: id, organizationId: orgId });
  if (!shift) throw new AppError("NOT_FOUND", "Shift not found", 404);
  if (await ShiftAssignmentModel.exists({ organizationId: orgId, shiftId: id })) throw new AppError("CONFLICT", "This shift is assigned to employees. End or move those assignments before deleting it.", 409);
  await ShiftModel.deleteOne({ _id: id, organizationId: orgId });
  await recordAudit({ actor, action: "workforce.shift_deleted", entityType: "workforce_shift", entityId: id, organizationId: orgId, before: { name: shift.name }, meta });
  return { id, deleted: true };
}

export async function assignShift(actor: AuthContext, orgId: string, input: z.infer<typeof shiftAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, shift] = await Promise.all([
    WorkforceEmployeeModel.exists({ _id: input.employeeId, organizationId: orgId, status: "active" }),
    ShiftModel.exists({ _id: input.shiftId, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] }),
  ]);
  if (!employee || !shift) throw new AppError("NOT_FOUND", "Active employee or effective shift not found in this organization", 404);
  const overlaps = await ShiftAssignmentModel.find({ organizationId: orgId, employeeId: input.employeeId, effectiveFrom: { $lte: input.effectiveTo ?? "9999-12-31" }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] });
  for (const previous of overlaps) {
    if (previous.effectiveFrom >= input.effectiveFrom) throw new AppError("CONFLICT", "A later shift assignment already exists; assignments cannot be backdated across it", 409);
    previous.effectiveTo = dayBefore(input.effectiveFrom); await previous.save();
  }
  const assignment = await ShiftAssignmentModel.create({ ...input, organizationId: orgId, assignedBy: actor.userId });
  await recordAudit({ actor, action: "workforce.shift_assigned", entityType: "workforce_shift_assignment", entityId: assignment._id.toString(), organizationId: orgId, after: input, meta });
  return { id: assignment._id.toString(), employeeId: input.employeeId, shiftId: input.shiftId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null };
}

function presentShiftSwap(swap: any) {
  return {
    id: swap._id.toString(),
    shiftDate: swap.shiftDate,
    reason: swap.reason,
    status: swap.status,
    requesterEmployee: swap.requesterEmployeeId && typeof swap.requesterEmployeeId === "object" && "firstName" in swap.requesterEmployeeId
      ? { id: swap.requesterEmployeeId._id.toString(), employeeNumber: swap.requesterEmployeeId.employeeNumber, name: `${swap.requesterEmployeeId.firstName} ${swap.requesterEmployeeId.lastName}`.trim() }
      : { id: swap.requesterEmployeeId?.toString() },
    targetEmployee: swap.targetEmployeeId && typeof swap.targetEmployeeId === "object" && "firstName" in swap.targetEmployeeId
      ? { id: swap.targetEmployeeId._id.toString(), employeeNumber: swap.targetEmployeeId.employeeNumber, name: `${swap.targetEmployeeId.firstName} ${swap.targetEmployeeId.lastName}`.trim() }
      : { id: swap.targetEmployeeId?.toString() },
    requesterShift: swap.requesterShiftId && typeof swap.requesterShiftId === "object" && "name" in swap.requesterShiftId
      ? { id: swap.requesterShiftId._id.toString(), name: swap.requesterShiftId.name, startTime: swap.requesterShiftId.startTime, endTime: swap.requesterShiftId.endTime, crossesMidnight: Boolean(swap.requesterShiftId.crossesMidnight) }
      : null,
    targetShift: swap.targetShiftId && typeof swap.targetShiftId === "object" && "name" in swap.targetShiftId
      ? { id: swap.targetShiftId._id.toString(), name: swap.targetShiftId.name, startTime: swap.targetShiftId.startTime, endTime: swap.targetShiftId.endTime, crossesMidnight: Boolean(swap.targetShiftId.crossesMidnight) }
      : null,
    reviewedBy: swap.reviewedBy?.toString() ?? null,
    reviewedAt: swap.reviewedAt ?? null,
    reviewComment: swap.reviewComment ?? "",
    createdAt: swap.createdAt,
  };
}

export async function requestShiftSwap(
  actor: AuthContext,
  orgId: string,
  input: z.infer<typeof shiftSwapCreateSchema>,
  meta: RequestMeta,
) {
  const requester = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId, status: "active" });
  if (!requester) throw new AppError("NOT_FOUND", "Active employee profile not found for current user", 404);
  if (requester._id.toString() === input.targetEmployeeId) {
    throw new AppError("VALIDATION_ERROR", "Cannot request a shift swap with yourself", 422);
  }
  const target = await WorkforceEmployeeModel.findOne({ _id: input.targetEmployeeId, organizationId: orgId, status: "active" });
  if (!target) throw new AppError("NOT_FOUND", "Target employee not found or inactive", 404);

  const existing = await ShiftSwapModel.findOne({
    organizationId: orgId,
    shiftDate: input.shiftDate,
    status: "pending",
    $or: [{ requesterEmployeeId: requester._id }, { targetEmployeeId: requester._id }],
  });
  if (existing) throw new AppError("CONFLICT", "You already have a pending shift swap request for this date", 409);

  const [requesterAssignment, targetAssignment] = await Promise.all([
    ShiftAssignmentModel.findOne({
      organizationId: orgId,
      employeeId: requester._id,
      effectiveFrom: { $lte: input.shiftDate },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.shiftDate } }],
    }),
    ShiftAssignmentModel.findOne({
      organizationId: orgId,
      employeeId: target._id,
      effectiveFrom: { $lte: input.shiftDate },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.shiftDate } }],
    }),
  ]);

  if (!requesterAssignment && !targetAssignment) {
    throw new AppError("VALIDATION_ERROR", "At least one employee must have an assigned shift on this date to swap", 422);
  }

  const swap = await ShiftSwapModel.create({
    organizationId: orgId,
    requesterEmployeeId: requester._id,
    targetEmployeeId: target._id,
    requesterShiftId: requesterAssignment?.shiftId ?? null,
    targetShiftId: targetAssignment?.shiftId ?? null,
    shiftDate: input.shiftDate,
    reason: input.reason,
    status: "pending",
  });

  await recordAudit({
    actor,
    action: "workforce.shift_swap_requested",
    entityType: "workforce_shift_swap",
    entityId: swap._id.toString(),
    organizationId: orgId,
    after: { ...input, requesterEmployeeId: requester._id.toString() },
    meta,
  });

  return presentShiftSwap(swap);
}

export async function listShiftSwaps(actor: AuthContext, orgId: string, mineOnly = false) {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const profile = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId });
  if (mineOnly || actor.role === "employee") {
    if (!profile) return [];
    filter.$or = [{ requesterEmployeeId: profile._id }, { targetEmployeeId: profile._id }];
  }

  const swaps: any = await ShiftSwapModel.find(filter)
    .populate("requesterEmployeeId", "employeeNumber firstName lastName")
    .populate("targetEmployeeId", "employeeNumber firstName lastName")
    .populate("requesterShiftId", "name startTime endTime crossesMidnight")
    .populate("targetShiftId", "name startTime endTime crossesMidnight")
    .sort({ shiftDate: -1, createdAt: -1 })
    .lean();

  return swaps.map(presentShiftSwap);
}

export async function reviewShiftSwap(
  actor: AuthContext,
  orgId: string,
  swapId: string,
  input: z.infer<typeof shiftSwapReviewSchema>,
  meta: RequestMeta,
) {
  const swap = await ShiftSwapModel.findOne({ _id: swapId, organizationId: orgId, status: "pending" });
  if (!swap) throw new AppError("NOT_FOUND", "Pending shift swap request not found", 404);

  swap.status = input.decision;
  swap.reviewedBy = new Types.ObjectId(actor.userId);
  swap.reviewedAt = new Date();
  swap.reviewComment = input.comment ?? "";
  await swap.save();

  await recordAudit({
    actor,
    action: `workforce.shift_swap_${input.decision}`,
    entityType: "workforce_shift_swap",
    entityId: swap._id.toString(),
    organizationId: orgId,
    after: { status: swap.status, reviewComment: swap.reviewComment },
    meta,
  });

  return presentShiftSwap(swap);
}

export async function cancelShiftSwap(actor: AuthContext, orgId: string, swapId: string, meta: RequestMeta) {
  const profile = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId });
  const swap = await ShiftSwapModel.findOne({ _id: swapId, organizationId: orgId, status: "pending" });
  if (!swap) throw new AppError("NOT_FOUND", "Pending shift swap request not found", 404);
  if (actor.role !== "org_admin" && (!profile || swap.requesterEmployeeId.toString() !== profile._id.toString())) {
    throw new AppError("FORBIDDEN", "Only the requester or an administrator can cancel this swap request", 403);
  }
  swap.status = "cancelled";
  await swap.save();
  await recordAudit({
    actor,
    action: "workforce.shift_swap_cancelled",
    entityType: "workforce_shift_swap",
    entityId: swap._id.toString(),
    organizationId: orgId,
    meta,
  });
  return { id: swap._id.toString(), status: "cancelled" };
}

export async function listCompensation(actor: AuthContext, orgId: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const [components, structures, assignments] = await Promise.all([
    CompensationComponentModel.find({ organizationId: orgId }).sort({ name: 1 }).lean(),
    PayStructureModel.find({ organizationId: orgId }).sort({ effectiveFrom: -1, name: 1 }).lean(),
    CompensationAssignmentModel.find({ organizationId: orgId, ...(employeeIds ? { employeeId: { $in: employeeIds } } : {}), $or: [{ effectiveTo: null }, { effectiveTo: { $gte: new Date().toISOString().slice(0, 10) } }] }).populate("employeeId", "employeeNumber firstName lastName").populate("structureId", "name mode payBasis baseRateMinor").sort({ effectiveFrom: -1 }).lean(),
  ]);
  return { components: components.map((item) => ({ id: item._id.toString(), code: item.code, name: item.name, kind: item.kind, calculation: item.calculation, amountMinor: item.amountMinor, rateBasisPoints: item.rateBasisPoints, basisComponentCode: item.basisComponentCode, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), structures: structures.map((item) => ({ id: item._id.toString(), name: item.name, mode: item.mode, payBasis: item.payBasis, baseRateMinor: item.baseRateMinor, components: item.components, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), assignments: assignments.map((item: any) => ({ id: item._id.toString(), employee: item.employeeId, structure: item.structureId, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo })) };
}

export async function createCompensationComponent(actor: AuthContext, orgId: string, input: z.infer<typeof componentSchema>, meta: RequestMeta) {
  const component = await CompensationComponentModel.create({ ...input, organizationId: orgId });
  await recordAudit({ actor, action: "payroll.component_created", entityType: "compensation_component", entityId: component._id.toString(), organizationId: orgId, after: input, meta });
  return { id: component._id.toString(), ...input };
}

export async function createPayStructure(actor: AuthContext, orgId: string, input: z.infer<typeof payStructureSchema>, meta: RequestMeta) {
  const components = input.componentIds.length ? await CompensationComponentModel.find({ _id: { $in: input.componentIds }, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] }) : [];
  if (components.length !== input.componentIds.length) throw new AppError("VALIDATION_ERROR", "All selected components must be active for this organization and effective date", 422);
  const lines = components.map((component) => ({ componentId: component._id, code: component.code, name: component.name, kind: component.kind, calculation: component.calculation, amountMinor: component.amountMinor, rateBasisPoints: component.rateBasisPoints, basisComponentCode: component.basisComponentCode }));
  for (const line of lines) if (line.calculation === "percentage" && line.basisComponentCode !== "BASE" && !lines.some((other) => other.code === line.basisComponentCode)) throw new AppError("VALIDATION_ERROR", `Unknown percentage basis: ${line.basisComponentCode}`, 422);
  const structure = await PayStructureModel.create({ ...input, components: lines, organizationId: orgId });
  await recordAudit({ actor, action: "payroll.structure_created", entityType: "pay_structure", entityId: structure._id.toString(), organizationId: orgId, after: { ...input, components: lines }, meta });
  return { id: structure._id.toString(), name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, status: structure.status };
}

export async function updatePayStructure(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof payStructureSchema>, meta: RequestMeta) {
  const components = input.componentIds.length ? await CompensationComponentModel.find({ _id: { $in: input.componentIds }, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] }) : [];
  if (components.length !== input.componentIds.length) throw new AppError("VALIDATION_ERROR", "All selected components must be active for this organization and effective date", 422);
  const lines = components.map((component) => ({ componentId: component._id, code: component.code, name: component.name, kind: component.kind, calculation: component.calculation, amountMinor: component.amountMinor, rateBasisPoints: component.rateBasisPoints, basisComponentCode: component.basisComponentCode }));
  for (const line of lines) if (line.calculation === "percentage" && line.basisComponentCode !== "BASE" && !lines.some((other) => other.code === line.basisComponentCode)) throw new AppError("VALIDATION_ERROR", `Unknown percentage basis: ${line.basisComponentCode}`, 422);
  const structure = await PayStructureModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: { ...input, components: lines } }, { new: true, runValidators: true });
  if (!structure) throw new AppError("NOT_FOUND", "Pay structure not found", 404);
  await recordAudit({ actor, action: "payroll.structure_updated", entityType: "pay_structure", entityId: id, organizationId: orgId, after: { ...input, components: lines }, meta });
  return { id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, status: structure.status };
}

export async function deletePayStructure(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  if (await CompensationAssignmentModel.exists({ organizationId: orgId, structureId: id })) throw new AppError("CONFLICT", "This pay structure is assigned to an employee and cannot be deleted. Mark it inactive instead.", 409);
  const structure = await PayStructureModel.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!structure) throw new AppError("NOT_FOUND", "Pay structure not found", 404);
  await recordAudit({ actor, action: "payroll.structure_deleted", entityType: "pay_structure", entityId: id, organizationId: orgId, before: { name: structure.name }, meta });
  return { id, deleted: true };
}

export async function assignCompensation(actor: AuthContext, orgId: string, input: z.infer<typeof compensationAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, structure] = await Promise.all([
    WorkforceEmployeeModel.exists({ _id: input.employeeId, organizationId: orgId, status: "active" }),
    PayStructureModel.findOne({ _id: input.structureId, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] }),
  ]);
  if (!employee || !structure) throw new AppError("NOT_FOUND", "Active employee or effective pay structure not found in this organization", 404);
  const overlaps = await CompensationAssignmentModel.find({ organizationId: orgId, employeeId: input.employeeId, effectiveFrom: { $lte: input.effectiveTo ?? "9999-12-31" }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] });
  for (const previous of overlaps) {
    if (previous.effectiveFrom >= input.effectiveFrom) throw new AppError("CONFLICT", "A later compensation assignment already exists; assignments cannot be backdated across it", 409);
    previous.effectiveTo = dayBefore(input.effectiveFrom); await previous.save();
  }
  const assignment = await CompensationAssignmentModel.create({ ...input, organizationId: orgId, assignedBy: actor.userId, rateSnapshot: { structureId: structure._id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, capturedAt: new Date() } });
  await recordAudit({ actor, action: "payroll.compensation_assigned", entityType: "compensation_assignment", entityId: assignment._id.toString(), organizationId: orgId, after: input, meta });
  return { id: assignment._id.toString(), employeeId: input.employeeId, structureId: input.structureId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, rateSnapshot: assignment.rateSnapshot };
}

export async function updateCompensationAssignment(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof compensationAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, structure, current] = await Promise.all([
    WorkforceEmployeeModel.findOne({ _id: input.employeeId, organizationId: orgId, status: "active" }),
    PayStructureModel.findOne({ _id: input.structureId, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] }),
    CompensationAssignmentModel.findOne({ _id: id, organizationId: orgId }),
  ]);
  if (!employee || !structure || !current) throw new AppError("NOT_FOUND", "Employee, pay structure, or assignment was not found", 404);
  if (await CompensationAssignmentModel.exists({ organizationId: orgId, _id: { $ne: id }, employeeId: input.employeeId, effectiveFrom: { $lte: input.effectiveTo ?? "9999-12-31" }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.effectiveFrom } }] })) throw new AppError("CONFLICT", "This employee already has an overlapping pay assignment", 409);
  Object.assign(current, input, { rateSnapshot: { structureId: structure._id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, capturedAt: new Date() } });
  await current.save();
  await recordAudit({ actor, action: "payroll.compensation_assignment_updated", entityType: "compensation_assignment", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteCompensationAssignment(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const assignment = await CompensationAssignmentModel.findOne({ _id: id, organizationId: orgId });
  if (!assignment) throw new AppError("NOT_FOUND", "Pay assignment not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, assignment.employeeId.toString());
  if (await PayrollRunModel.exists({ organizationId: orgId, periodStart: { $lte: assignment.effectiveTo ?? "9999-12-31" }, periodEnd: { $gte: assignment.effectiveFrom }, "employees.employeeId": assignment.employeeId })) throw new AppError("CONFLICT", "This assignment is included in a payroll run and cannot be deleted.", 409);
  await assignment.deleteOne();
  await recordAudit({ actor, action: "payroll.compensation_assignment_deleted", entityType: "compensation_assignment", entityId: id, organizationId: orgId, before: { employeeId: assignment.employeeId.toString(), structureId: assignment.structureId.toString() }, meta });
  return { id, deleted: true };
}

export async function listDailyEarnings(actor: AuthContext, orgId: string, from?: string, to?: string, employeeId?: string) {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (visibleEmployeeIds) filter.employeeId = { $in: visibleEmployeeIds };
  if (from || to) filter.earningDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (employeeId) { await assertWorkforceEmployeeAccessible(orgId, actor, employeeId); filter.employeeId = employeeId; }
  const entries = await DailyEarningModel.find(filter).populate("employeeId", "employeeNumber firstName lastName").sort({ earningDate: -1, createdAt: -1 }).limit(500).lean();
  return entries.map((entry: any) => ({ id: entry._id.toString(), employee: entry.employeeId, earningDate: entry.earningDate, source: entry.source, description: entry.description, quantityThousandths: entry.quantityThousandths, rateMinor: entry.rateMinor, amountMinor: entry.amountMinor, currency: entry.currency, status: entry.status, adjustmentOf: entry.adjustmentOf?.toString() ?? null, createdAt: entry.createdAt }));
}

export async function createDailyEarning(actor: AuthContext, orgId: string, currency: string, input: z.infer<typeof dailyEarningCreateSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  if (!await WorkforceEmployeeModel.exists({ _id: input.employeeId, organizationId: orgId })) throw new AppError("NOT_FOUND", "Employee profile not found", 404);
  const amountMinor = calculateDailyAmountMinor(input.quantityThousandths, input.rateMinor);
  const entry = await DailyEarningModel.create({ ...input, amountMinor, currency, organizationId: orgId, createdBy: actor.userId });
  await recordAudit({ actor, action: "payroll.daily_earning_created", entityType: "daily_earning", entityId: entry._id.toString(), organizationId: orgId, after: { ...input, amountMinor, currency }, meta });
  return { id: entry._id.toString(), employeeId: input.employeeId, earningDate: entry.earningDate, amountMinor, rateMinor: entry.rateMinor, quantityThousandths: entry.quantityThousandths, status: entry.status };
}

export async function reviewDailyEarning(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof dailyEarningReviewSchema>, meta: RequestMeta) {
  const entry = await DailyEarningModel.findOne({ _id: id, organizationId: orgId, status: "pending" });
  if (!entry) throw new AppError("NOT_FOUND", "Pending earning entry not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, entry.employeeId.toString());
  entry.status = input.decision;
  await entry.save();
  await recordAudit({ actor, action: `payroll.daily_earning_${input.decision}`, entityType: "daily_earning", entityId: id, organizationId: orgId, after: { status: input.decision }, meta });
  return { id, status: entry.status };
}

export async function listOvertime(actor: AuthContext, orgId: string, section: "policies" | "entries" | "all" = "all") {
  const employeeIds = section === "policies" ? null : await accessibleWorkforceEmployeeIds(orgId, actor);
  const [policies, entries] = await Promise.all([
    section !== "entries" ? OvertimePolicyModel.find({ organizationId: orgId }).sort({ effectiveFrom: -1 }).lean() : Promise.resolve([]),
    section !== "policies" ? OvertimeEntryModel.find({ organizationId: orgId, ...(employeeIds ? { employeeId: { $in: employeeIds } } : {}) }).populate("employeeId", "employeeNumber firstName lastName").sort({ workDate: -1, createdAt: -1 }).limit(500).lean() : Promise.resolve([]),
  ]);
  return { policies: policies.map((item) => ({ id: item._id.toString(), name: item.name, calculation: item.calculation, multiplierBasisPoints: item.multiplierBasisPoints, hourlyRateMinor: item.hourlyRateMinor, minimumMinutes: item.minimumMinutes, roundingMinutes: item.roundingMinutes, maximumMinutesPerDay: item.maximumMinutesPerDay, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), entries: entries.map((item: any) => ({ id: item._id.toString(), employee: item.employeeId, workDate: item.workDate, actualMinutes: item.actualMinutes, calculatedMinutes: item.calculatedMinutes, approvedMinutes: item.approvedMinutes, hourlyRateMinor: item.hourlyRateMinor, payableAmountMinor: item.payableAmountMinor, status: item.status, reason: item.reason, policySnapshot: item.policySnapshot })) };
}

export async function createOvertimePolicy(actor: AuthContext, orgId: string, input: z.infer<typeof overtimePolicySchema>, meta: RequestMeta) {
  const policy = await OvertimePolicyModel.create({ ...input, organizationId: orgId });
  await recordAudit({ actor, action: "overtime.policy_created", entityType: "overtime_policy", entityId: policy._id.toString(), organizationId: orgId, after: input, meta });
  return { id: policy._id.toString(), ...input };
}

export async function updateOvertimePolicy(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof overtimePolicySchema>, meta: RequestMeta) {
  const policy = await OvertimePolicyModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: input }, { new: true, runValidators: true });
  if (!policy) throw new AppError("NOT_FOUND", "Overtime policy not found", 404);
  await recordAudit({ actor, action: "overtime.policy_updated", entityType: "overtime_policy", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteOvertimePolicy(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  if (await OvertimeEntryModel.exists({ organizationId: orgId, policyId: id })) throw new AppError("CONFLICT", "This policy is used by overtime records and cannot be deleted. Mark it inactive instead.", 409);
  const policy = await OvertimePolicyModel.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!policy) throw new AppError("NOT_FOUND", "Overtime policy not found", 404);
  await recordAudit({ actor, action: "overtime.policy_deleted", entityType: "overtime_policy", entityId: id, organizationId: orgId, before: { name: policy.name }, meta });
  return { id, deleted: true };
}

export async function createOvertimeEntry(actor: AuthContext, orgId: string, input: z.infer<typeof overtimeCreateSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const employee = await WorkforceEmployeeModel.findOne({ _id: input.employeeId, organizationId: orgId, status: "active" });
  if (!employee) throw new AppError("NOT_FOUND", "Active employee profile not found", 404);
  const policy = await OvertimePolicyModel.findOne({ _id: input.policyId, organizationId: orgId, status: "active", effectiveFrom: { $lte: input.workDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.workDate } }] });
  if (!policy) throw new AppError("VALIDATION_ERROR", "No active overtime policy applies to this date", 422);
  const rounded = Math.floor(input.actualMinutes / policy.roundingMinutes) * policy.roundingMinutes;
  const existingMinutes = await OvertimeEntryModel.aggregate([{ $match: { organizationId: new Types.ObjectId(orgId), employeeId: employee._id, workDate: input.workDate, status: { $in: ["pending", "approved", "paid"] } } }, { $group: { _id: null, minutes: { $sum: "$calculatedMinutes" } } }]);
  const remainingDailyMinutes = Math.max(0, policy.maximumMinutesPerDay - (existingMinutes[0]?.minutes ?? 0));
  const calculatedMinutes = Math.min(rounded >= policy.minimumMinutes ? rounded : 0, remainingDailyMinutes);
  let hourlyRateMinor = policy.hourlyRateMinor;
  if (policy.calculation === "multiplier") {
    const assignment: any = await CompensationAssignmentModel.findOne({ organizationId: orgId, employeeId: input.employeeId, effectiveFrom: { $lte: input.workDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.workDate } }] }).sort({ effectiveFrom: -1 }).lean();
    if (assignment?.rateSnapshot?.payBasis === "hourly") hourlyRateMinor = assignment.rateSnapshot.baseRateMinor;
    if (hourlyRateMinor <= 0) throw new AppError("VALIDATION_ERROR", "Multiplier overtime requires an hourly pay assignment or a fixed hourly rate", 422);
  }
  const entry = await OvertimeEntryModel.create({ organizationId: orgId, employeeId: input.employeeId, workDate: input.workDate, actualMinutes: input.actualMinutes, calculatedMinutes, approvedMinutes: 0, policyId: policy._id, policySnapshot: { name: policy.name, calculation: policy.calculation, multiplierBasisPoints: policy.multiplierBasisPoints, hourlyRateMinor, roundingMinutes: policy.roundingMinutes, maximumMinutesPerDay: policy.maximumMinutesPerDay, capturedAt: new Date() }, hourlyRateMinor, payableAmountMinor: 0, status: "pending", reason: input.reason, createdBy: actor.userId });
  await recordAudit({ actor, action: "overtime.entry_created", entityType: "overtime_entry", entityId: entry._id.toString(), organizationId: orgId, after: { ...input, calculatedMinutes, policyId: policy._id.toString() }, meta });
  return { id: entry._id.toString(), calculatedMinutes, status: entry.status, actualMinutes: entry.actualMinutes };
}

export async function reviewOvertime(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof dailyEarningReviewSchema>, meta: RequestMeta) {
  const entry = await OvertimeEntryModel.findOne({ _id: id, organizationId: orgId, status: "pending" });
  if (!entry) throw new AppError("NOT_FOUND", "Pending overtime record not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, entry.employeeId.toString());
  entry.status = input.decision;
  entry.reviewedBy = new Types.ObjectId(actor.userId);
  entry.reviewedAt = new Date();
  if (input.decision === "approved") {
    entry.approvedMinutes = entry.calculatedMinutes;
    const multiplier = entry.policySnapshot.calculation === "multiplier" ? entry.policySnapshot.multiplierBasisPoints : 10000;
    entry.payableAmountMinor = calculateOvertimeAmountMinor(entry.approvedMinutes, entry.hourlyRateMinor, multiplier);
  } else { entry.approvedMinutes = 0; entry.payableAmountMinor = 0; }
  await entry.save();
  await recordAudit({ actor, action: `overtime.entry_${input.decision}`, entityType: "overtime_entry", entityId: id, organizationId: orgId, after: { status: entry.status, approvedMinutes: entry.approvedMinutes, payableAmountMinor: entry.payableAmountMinor }, meta });
  return { id, status: entry.status, approvedMinutes: entry.approvedMinutes, payableAmountMinor: entry.payableAmountMinor };
}

export async function listPayrollRuns(actor: AuthContext, orgId: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const runs = await PayrollRunModel.find({ organizationId: orgId }).sort({ createdAt: -1, periodStart: -1, revision: -1 }).limit(200).lean();
  return runs.filter((run) => !employeeIds || run.employees.every((employee) => employeeIds.some((id) => id.toString() === employee.employeeId.toString()))).slice(0, 100).map((run) => ({ id: run._id.toString(), name: run.name || "Payroll", periodKey: run.periodKey, periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, state: run.state, employees: run.employees, payments: run.payments, totals: run.totals, revision: run.revision, revisionOf: run.revisionOf?.toString() ?? null, revisionReason: run.revisionReason, reversedAt: run.reversedAt, createdAt: run.createdAt, finalizedAt: run.finalizedAt }));
}

export async function listOwnPayrollRuns(actor: AuthContext, orgId: string) {
  const employee = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId }).select("_id");
  if (!employee) return [];
  const runs = await PayrollRunModel.find({ organizationId: orgId, state: { $in: ["finalized", "partially_paid", "paid"] }, "employees.employeeId": employee._id }).sort({ periodStart: -1 }).lean();
  return runs.map((run) => ({ id: run._id.toString(), name: run.name || "Payroll", periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, state: run.state, payslip: run.employees.find((item) => item.employeeId.toString() === employee._id.toString()) }));
}

function payrollPeriodKey(start: string, end: string) { return `${start}_${end}`; }

export async function createPayrollRun(actor: AuthContext, orgId: string, currency: string, period: z.infer<typeof payrollPeriodSchema>, meta: RequestMeta) {
  const attendancePolicy: any = await AttendancePolicyModel.findOne({ organizationId: orgId }).lean();
  const policyWeeklyOffs: number[] = Array.isArray(attendancePolicy?.weeklyHolidays) ? attendancePolicy.weeklyHolidays : [0, 6];
  const periodKey = `${payrollPeriodKey(period.periodStart, period.periodEnd)}_${new Types.ObjectId().toString()}`;
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const activeEmployees: any[] = await WorkforceEmployeeModel.find({ organizationId: orgId, status: "active", ...(employeeIds ? { _id: { $in: employeeIds } } : {}) }).select("employeeNumber firstName lastName status userId joiningDate email phone designationId departmentId").populate("designationId", "name").populate("departmentId", "name").lean();
  const employeeRuns = [];
  for (const employee of activeEmployees) {
    const assignment: any = await CompensationAssignmentModel.findOne({ organizationId: orgId, employeeId: employee._id, effectiveFrom: { $lte: period.periodEnd }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: period.periodStart } }] }).sort({ effectiveFrom: -1 }).lean();
    const snapshot = assignment?.rateSnapshot ?? { payBasis: "none", baseRateMinor: 0, components: [] };
    const serviceStart = [period.periodStart, assignment?.effectiveFrom, employee.joiningDate].filter(Boolean).sort().at(-1)!;
    const serviceEnd = [period.periodEnd, assignment?.effectiveTo].filter(Boolean).sort()[0]!;
    const serviceDays = serviceEnd < serviceStart ? 0 : Math.round((Date.parse(`${serviceEnd}T00:00:00Z`) - Date.parse(`${serviceStart}T00:00:00Z`)) / 86400000) + 1;
    if (serviceDays === 0) continue;
    const periodBaseRateMinor = snapshot.payBasis === "monthly" ? prorateMonthlyRateByWorkdays(snapshot.baseRateMinor, serviceStart, serviceEnd, policyWeeklyOffs) : snapshot.baseRateMinor;
    const lines: Array<{ code: string; name: string; kind: "earning" | "deduction" | "employer_contribution"; amountMinor: number; source: string; sourceId?: Types.ObjectId | null }> = [];
    const values = new Map<string, number>([["BASE", periodBaseRateMinor]]);
    if (snapshot.payBasis === "monthly" && periodBaseRateMinor > 0) lines.push({ code: "BASE", name: "Base salary", kind: "earning", amountMinor: periodBaseRateMinor, source: "salary_structure" });
    const components = snapshot.components as Array<{ code: string; name: string; kind: "earning" | "deduction" | "employer_contribution"; calculation: "fixed" | "percentage"; amountMinor: number; rateBasisPoints: number; basisComponentCode: string }>;
    const pending = new Map(components.map((item) => [item.code, item]));
    for (let count = 0; pending.size && count <= components.length; count++) {
      let progressed = false;
      for (const [code, component] of pending) {
        const basis = component.basisComponentCode === "BASE" ? periodBaseRateMinor : values.get(component.basisComponentCode);
        if (component.calculation === "percentage" && basis === undefined) continue;
        const fixedAmountMinor = snapshot.payBasis === "monthly" ? prorateMonthlyRateByWorkdays(component.amountMinor, serviceStart, serviceEnd, policyWeeklyOffs) : component.amountMinor;
        const amountMinor = component.calculation === "fixed" ? fixedAmountMinor : calculatePercentageMinor(basis!, component.rateBasisPoints);
        values.set(code, amountMinor);
        lines.push({ code, name: component.name, kind: component.kind, amountMinor, source: "salary_structure" });
        pending.delete(code); progressed = true;
      }
      if (!progressed && pending.size) throw new AppError("VALIDATION_ERROR", "Salary component percentage bases contain an unresolved dependency", 422);
    }
    const [earnings, overtime, leaveRequests, attendance, attendanceAdjustments, shiftAssignment] = await Promise.all([
      DailyEarningModel.find({ organizationId: orgId, employeeId: employee._id, earningDate: { $gte: period.periodStart, $lte: period.periodEnd }, status: "approved" }).lean(),
      OvertimeEntryModel.find({ organizationId: orgId, employeeId: employee._id, workDate: { $gte: period.periodStart, $lte: period.periodEnd }, status: "approved", approvedMinutes: { $gt: 0 } }).lean(),
      LeaveRequestModel.find({ organizationId: orgId, employeeId: employee._id, status: "approved", startDate: { $lte: period.periodEnd }, endDate: { $gte: period.periodStart } }).populate("leaveTypeId", "paid name").lean(),
      employee.userId ? AttendanceRecordModel.find({ organizationId: orgId, employeeId: employee.userId, attendanceDate: { $gte: serviceStart, $lte: serviceEnd }, status: { $in: ["completed", "checked_in"] } }).select("attendanceDate totalWorkingMinutes checkIn.at checkOut.at halfDay").lean() : [],
      AttendanceAdjustmentModel.find({ organizationId: orgId, attendanceDate: { $gte: serviceStart, $lte: serviceEnd }, $or: [{ workforceEmployeeId: employee._id }, ...(employee.userId ? [{ employeeId: employee.userId }] : [])] }).select("attendanceDate status checkInAt checkOutAt").lean(),
      ShiftAssignmentModel.findOne({ organizationId: orgId, employeeId: employee._id, effectiveFrom: { $lte: period.periodEnd }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: period.periodStart } }] }).populate("shiftId", "weeklyOffs").sort({ effectiveFrom: -1 }).lean(),
    ]);
    const attendanceByDate = new Map<string, number>(attendance.map((record) => [record.attendanceDate, record.totalWorkingMinutes ?? 0]));
    const recordByDate = new Map(attendance.map((record: any) => [record.attendanceDate, record]));
    for (const adjustment of attendanceAdjustments) {
      if (adjustment.status === "present" || adjustment.status === "half_day") {
        const minutes = adjustment.checkInAt && adjustment.checkOutAt ? Math.max(0, Math.floor((adjustment.checkOutAt.getTime() - adjustment.checkInAt.getTime()) / 60_000)) : 0;
        attendanceByDate.set(adjustment.attendanceDate, minutes || (adjustment.status === "half_day" ? Math.round((attendancePolicy?.halfDayHours ?? 4) * 60) : 0));
      } else attendanceByDate.delete(adjustment.attendanceDate);
    }
    const adjustmentByDate = new Map(attendanceAdjustments.map((item: any) => [item.attendanceDate, item]));
    const attendanceRecordByDate = recordByDate;
    const overtimeByDate = new Map<string, number>();
    for (const item of overtime) overtimeByDate.set(item.workDate, (overtimeByDate.get(item.workDate) ?? 0) + item.payableAmountMinor);
    const shiftWeeklyOffs: number[] = (shiftAssignment as any)?.shiftId?.weeklyOffs ?? [0, 6];
    const weeklyOffs: number[] = Array.isArray(attendancePolicy?.weeklyHolidays) ? policyWeeklyOffs : shiftWeeklyOffs;
    const leaveByDate = new Map<string, { paid: boolean; units: number }>();
    for (const leave of leaveRequests as any[]) {
      const typeIsPaid = Boolean(leave.leaveTypeId?.paid);
      let leaveCursor = new Date(`${leave.startDate}T00:00:00Z`); const leaveLast = new Date(`${leave.endDate}T00:00:00Z`); let assignedUnits = 0;
      while (leaveCursor <= leaveLast && assignedUnits < leave.days) {
        const leaveDate = leaveCursor.toISOString().slice(0, 10);
        if (!weeklyOffs.includes(leaveCursor.getUTCDay())) {
          const units = Math.min(1, leave.days - assignedUnits);
          leaveByDate.set(leaveDate, { paid: typeIsPaid, units });
          assignedUnits += units;
        }
        leaveCursor.setUTCDate(leaveCursor.getUTCDate() + 1);
      }
    }
    const attendanceDays: Array<{ date: string; status: string; checkInAt?: Date | null; checkOutAt?: Date | null; overtimeAmountMinor: number; isPaidLeave?: boolean; leaveUnits?: number }> = [];
    let cursor = new Date(`${serviceStart}T00:00:00Z`); const serviceLast = new Date(`${serviceEnd}T00:00:00Z`); let scheduledWorkDays = 0;
    while (cursor <= serviceLast) {
      const date = cursor.toISOString().slice(0, 10); const dayOff = weeklyOffs.includes(cursor.getUTCDay());
      if (!dayOff) scheduledWorkDays++;
      const adjustment: any = adjustmentByDate.get(date); const record: any = attendanceRecordByDate.get(date);
      const leave = leaveByDate.get(date);
      const recordStatus = record?.halfDay ? "half_day" : record ? "present" : "missing";
      const status = dayOff ? "day_off" : adjustment?.status ?? (leave ? "leave" : recordStatus);
      attendanceDays.push({ date, status, leaveUnits: leave?.units, isPaidLeave: leave?.paid, checkInAt: adjustment?.checkInAt ?? record?.checkIn?.at ?? null, checkOutAt: adjustment?.checkOutAt ?? record?.checkOut?.at ?? null, overtimeAmountMinor: overtimeByDate.get(date) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const paidAttendanceUnits = attendanceDays.reduce((sum, day) => sum + (day.status === "present" ? 1 : day.status === "half_day" ? 0.5 : day.status === "leave" && day.isPaidLeave ? day.leaveUnits ?? 1 : 0), 0);
    const monthlyAttendanceFactor = scheduledWorkDays > 0 ? Math.min(1, paidAttendanceUnits / scheduledWorkDays) : 0;
    if (snapshot.payBasis === "monthly") {
      for (const line of lines.filter((item) => item.source === "salary_structure")) line.amountMinor = Math.round(line.amountMinor * monthlyAttendanceFactor);
      const unpaidLeaveUnits = attendanceDays.reduce((sum, day) => sum + (day.status === "leave" && day.isPaidLeave === false ? day.leaveUnits ?? 1 : 0), 0);
      const lopMinor = scheduledWorkDays > 0 ? Math.round(periodBaseRateMinor * unpaidLeaveUnits / scheduledWorkDays) : 0;
      if (lopMinor > 0) lines.push({ code: `LOP_${employee._id}`, name: `Unpaid leave · ${unpaidLeaveUnits} working day(s)`, kind: "deduction", amountMinor: lopMinor, source: "approved_unpaid_leave" });
    }
    const attendedDays = Math.round(attendanceDays.reduce((sum, day) => sum + (day.status === "present" ? 1 : day.status === "half_day" ? 0.5 : 0), 0) * 1000);
    const workedMinutes = [...attendanceByDate.values()].reduce((sum, minutes) => sum + minutes, 0);
    if (snapshot.payBasis === "daily" || snapshot.payBasis === "shift") {
      const amountMinor = calculateDailyAmountMinor(attendedDays, snapshot.baseRateMinor);
      if (amountMinor > 0) lines.push({ code: "ATTENDANCE_BASE", name: `Attendance base · ${(attendedDays / 1000).toFixed(attendedDays % 1000 ? 1 : 0)} day(s)`, kind: "earning", amountMinor, source: "attendance" });
    } else if (snapshot.payBasis === "hourly") {
      const amountMinor = calculateAttendanceBaseMinor(snapshot.payBasis, snapshot.baseRateMinor, attendedDays, workedMinutes);
      if (amountMinor > 0) lines.push({ code: "ATTENDANCE_BASE", name: `Attendance base · ${workedMinutes} minute(s)`, kind: "earning", amountMinor, source: "attendance" });
    }
    for (const earning of earnings) lines.push({ code: `DAILY_${earning._id}`, name: earning.description, kind: "earning", amountMinor: earning.amountMinor, source: `daily_${earning.source}`, sourceId: earning._id });
    for (const item of overtime) lines.push({ code: `OT_${item._id}`, name: "Approved overtime", kind: "earning", amountMinor: item.payableAmountMinor, source: "approved_overtime", sourceId: item._id });
    for (const leave of leaveRequests as any[]) {
      if (leave.startDate < period.periodStart || leave.endDate > period.periodEnd) throw new AppError("VALIDATION_ERROR", "An approved leave request crosses this payroll period boundary; split the request before previewing payroll", 422);
    }
    const total = (kind: "earning" | "deduction" | "employer_contribution") => lines.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.amountMinor, 0);
    const grossEarningsMinor = total("earning"); const deductionsMinor = total("deduction"); const employerContributionsMinor = total("employer_contribution");
    employeeRuns.push({ employeeId: employee._id, employeeNumber: employee.employeeNumber, employeeName: `${employee.firstName} ${employee.lastName}`.trim(), email: employee.email ?? employee.userId?.email ?? "", phone: employee.phone ?? "", departmentName: employee.departmentId?.name ?? "", designationName: employee.designationId?.name ?? "", joiningDate: employee.joiningDate ?? "", currency, dailyRateMinor: snapshot.payBasis === "monthly" && scheduledWorkDays > 0 ? Math.round(periodBaseRateMinor / scheduledWorkDays) : null, scheduledWorkDays: snapshot.payBasis === "monthly" ? scheduledWorkDays : null, structureSnapshot: snapshot, attendanceDays, lines, grossEarningsMinor, deductionsMinor, employerContributionsMinor, netPayMinor: Math.max(0, grossEarningsMinor - deductionsMinor), paidMinor: 0, paymentReference: "" });
  }
  if (!employeeRuns.length) throw new AppError("VALIDATION_ERROR", "There are no active employees in this period", 422);
  const totals = { employees: employeeRuns.length, grossEarningsMinor: employeeRuns.reduce((sum, item) => sum + item.grossEarningsMinor, 0), deductionsMinor: employeeRuns.reduce((sum, item) => sum + item.deductionsMinor, 0), employerContributionsMinor: employeeRuns.reduce((sum, item) => sum + item.employerContributionsMinor, 0), netPayMinor: employeeRuns.reduce((sum, item) => sum + item.netPayMinor, 0) };
  const name = period.name?.trim() || `Payroll ${period.periodStart} – ${period.periodEnd}`;
  const run = await PayrollRunModel.create({ organizationId: orgId, name, periodKey, periodStart: period.periodStart, periodEnd: period.periodEnd, currency, state: "draft", employees: employeeRuns, totals, createdBy: actor.userId });
  await recordAudit({ actor, action: "payroll.run_previewed", entityType: "payroll_run", entityId: run._id.toString(), organizationId: orgId, after: { name, periodKey, totals }, meta });
  return { id: run._id.toString(), name, periodKey, periodStart: period.periodStart, periodEnd: period.periodEnd, currency, state: run.state, totals, employees: employeeRuns };
}

export async function cancelPayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const run = await PayrollRunModel.findOneAndUpdate({ _id: id, organizationId: orgId, state: "draft", revisionOf: null }, { $set: { state: "cancelled", cancelledAt: new Date(), cancelledBy: actor.userId } }, { new: true });
  if (!run) throw new AppError("INVALID_STATE", "Only an unsubmitted payroll preview can be cancelled", 409);
  await recordAudit({ actor, action: "payroll.run_cancelled", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: run.state, periodStart: run.periodStart, periodEnd: run.periodEnd }, meta });
  return { id, state: run.state };
}

export async function deletePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const run = await PayrollRunModel.findOne({ _id: id, organizationId: orgId });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found", 404);
  if (run.payments.length || run.employees.some((employee) => employee.paidMinor > 0)) throw new AppError("INVALID_STATE", "A payroll run with recorded employee payments cannot be deleted", 409);
  await PayrollRunModel.deleteOne({ _id: run._id, organizationId: orgId });
  await recordAudit({ actor, action: "payroll.run_deleted", entityType: "payroll_run", entityId: id, organizationId: orgId, before: { periodStart: run.periodStart, periodEnd: run.periodEnd, state: run.state }, meta });
  return { id, deleted: true };
}

export async function createPayrollRevision(actor: AuthContext, orgId: string, originalId: string, input: z.infer<typeof payrollRevisionSchema>, meta: RequestMeta) {
  const original = await PayrollRunModel.findOne({ _id: originalId, organizationId: orgId, state: "finalized" }).lean();
  if (!original) throw new AppError("INVALID_STATE", "Only a finalized, unreversed payroll run can be revised", 409);
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (visibleEmployeeIds && original.employees.some((employee) => !visibleEmployeeIds.some((id) => id.toString() === employee.employeeId.toString()))) throw new AppError("NOT_FOUND", "Payroll run is outside your assigned workforce scope", 404);
  if (original.employees.some((employee) => employee.paidMinor !== 0) || original.payments.length > 0) throw new AppError("INVALID_STATE", "Paid payroll cannot be revised; create a separate adjustment or recovery record", 409);
  const activeRevision = await PayrollRunModel.exists({ organizationId: orgId, revisionOf: original._id, state: { $in: ["draft", "pending_approval", "approved", "finalized"] } });
  if (activeRevision) throw new AppError("CONFLICT", "This payroll run already has an active revision", 409);
  const latestRevision = await PayrollRunModel.findOne({ organizationId: orgId, periodKey: original.periodKey }).sort({ revision: -1 }).select("revision").lean();
  const nextRevisionNumber = (latestRevision?.revision ?? original.revision) + 1;
  const byEmployee = new Map(original.employees.map((employee) => [employee.employeeId.toString(), employee]));
  const employees = original.employees.map((source) => {
    const adjustment = input.adjustments.find((item) => item.employeeId === source.employeeId.toString());
    if (!adjustment) return { ...source, paidMinor: 0, paymentReference: "" };
    const gross = source.grossEarningsMinor + adjustment.grossDeltaMinor;
    const deductions = source.deductionsMinor + adjustment.deductionsDeltaMinor;
    const contributions = source.employerContributionsMinor + adjustment.employerContributionsDeltaMinor;
    const net = gross - deductions;
    if (![gross, deductions, contributions, net].every(Number.isSafeInteger) || gross < 0 || deductions < 0 || contributions < 0 || net < 0) throw new AppError("VALIDATION_ERROR", `Revision amounts for ${source.employeeNumber} would create an invalid payroll total`, 422);
    const lines = [...source.lines];
    const suffix = `${nextRevisionNumber}_${source.employeeNumber}`;
    if (adjustment.grossDeltaMinor) lines.push({ code: `REV_GROSS_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "earning", amountMinor: adjustment.grossDeltaMinor, source: "payroll_revision", sourceId: null } as never);
    if (adjustment.deductionsDeltaMinor) lines.push({ code: `REV_DEDUCTION_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "deduction", amountMinor: adjustment.deductionsDeltaMinor, source: "payroll_revision", sourceId: null } as never);
    if (adjustment.employerContributionsDeltaMinor) lines.push({ code: `REV_CONTRIBUTION_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "employer_contribution", amountMinor: adjustment.employerContributionsDeltaMinor, source: "payroll_revision", sourceId: null } as never);
    return { ...source, lines, grossEarningsMinor: gross, deductionsMinor: deductions, employerContributionsMinor: contributions, netPayMinor: net, paidMinor: 0, paymentReference: "" };
  });
  for (const adjustment of input.adjustments) if (!byEmployee.has(adjustment.employeeId)) throw new AppError("NOT_FOUND", "A revision adjustment references an employee outside the original payroll run", 404);
  const totals = { employees: employees.length, grossEarningsMinor: employees.reduce((sum, item) => sum + item.grossEarningsMinor, 0), deductionsMinor: employees.reduce((sum, item) => sum + item.deductionsMinor, 0), employerContributionsMinor: employees.reduce((sum, item) => sum + item.employerContributionsMinor, 0), netPayMinor: employees.reduce((sum, item) => sum + item.netPayMinor, 0) };
  if (![totals.grossEarningsMinor, totals.deductionsMinor, totals.employerContributionsMinor, totals.netPayMinor].every(Number.isSafeInteger)) throw new AppError("VALIDATION_ERROR", "Revision totals exceed the safe currency range", 422);
  const revision = await PayrollRunModel.create({ organizationId: orgId, name: original.name || "Payroll", periodKey: original.periodKey, periodStart: original.periodStart, periodEnd: original.periodEnd, currency: original.currency, state: "draft", employees, payments: [], totals, createdBy: actor.userId, revision: nextRevisionNumber, revisionOf: original._id, revisionReason: input.reason });
  await recordAudit({ actor, action: "payroll.revision_created", entityType: "payroll_run", entityId: revision._id.toString(), organizationId: orgId, before: { originalRunId: originalId, revision: original.revision, totals: original.totals }, after: { revision: revision.revision, reason: input.reason, totals }, meta });
  return { id: revision._id.toString(), revisionOf: originalId, revision: revision.revision, state: revision.state, periodStart: revision.periodStart, periodEnd: revision.periodEnd, totals, employees };
}

export async function cancelPayrollRevision(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const revision = await PayrollRunModel.findOneAndUpdate({ _id: id, organizationId: orgId, revisionOf: { $ne: null }, state: { $in: ["draft", "pending_approval"] } }, { $set: { state: "cancelled", cancelledAt: new Date(), cancelledBy: actor.userId } }, { new: true });
  if (!revision) throw new AppError("INVALID_STATE", "Only an unfinalized payroll revision can be cancelled", 409);
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (visibleEmployeeIds && revision.revisionOf) {
    const original = await PayrollRunModel.findOne({ _id: revision.revisionOf, organizationId: orgId }).select("employees.employeeId").lean();
    if (!original || original.employees.some((employee) => !visibleEmployeeIds.some((id) => id.toString() === employee.employeeId.toString()))) throw new AppError("NOT_FOUND", "Payroll revision is outside your assigned workforce scope", 404);
  }
  await recordAudit({ actor, action: "payroll.revision_cancelled", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: revision.state, revisionOf: revision.revisionOf?.toString(), reason: revision.revisionReason }, meta });
  return { id, state: revision.state };
}

type PayrollState = "draft" | "pending_approval" | "approved" | "finalized";
async function transitionPayrollRun(actor: AuthContext, orgId: string, id: string, from: PayrollState, to: PayrollState, action: string, meta: RequestMeta) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (employeeIds) {
    const scopedRun = await PayrollRunModel.findOne({ _id: id, organizationId: orgId }).select("employees.employeeId").lean();
    if (!scopedRun || scopedRun.employees.some((employee) => !employeeIds.some((visibleId) => visibleId.toString() === employee.employeeId.toString()))) throw new AppError("NOT_FOUND", "Payroll run is outside your assigned workforce scope", 404);
  }
  const update: Record<string, unknown> = { state: to };
  if (to === "approved") { update.approvedBy = actor.userId; update.approvedAt = new Date(); }
  if (to === "finalized") { update.finalizedBy = actor.userId; update.finalizedAt = new Date(); }
  const run = await PayrollRunModel.findOneAndUpdate({ _id: id, organizationId: orgId, state: from }, { $set: update as never }, { new: true, runValidators: true });
  if (!run) throw new AppError("CONFLICT", `Payroll run cannot transition from ${from} to ${to}`, 409);
  await recordAudit({ actor, action, entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: to }, meta });
  return { id, state: to, totals: run.get("totals") };
}

export async function submitPayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) { return transitionPayrollRun(actor, orgId, id, "draft", "pending_approval", "payroll.run_submitted", meta); }
export async function approvePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) { return transitionPayrollRun(actor, orgId, id, "pending_approval", "approved", "payroll.run_approved", meta); }
export async function finalizePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (employeeIds) {
    const scopedRun = await PayrollRunModel.findOne({ _id: id, organizationId: orgId }).select("employees.employeeId").lean();
    if (!scopedRun || scopedRun.employees.some((employee) => !employeeIds.some((visibleId) => visibleId.toString() === employee.employeeId.toString()))) throw new AppError("NOT_FOUND", "Payroll run is outside your assigned workforce scope", 404);
  }
  const revision = await PayrollRunModel.findOne({ _id: id, organizationId: orgId, state: "approved", revisionOf: { $ne: null } }).select("revisionOf");
  if (revision?.revisionOf) {
    const original = await PayrollRunModel.findOneAndUpdate({ _id: revision.revisionOf, organizationId: orgId, state: "finalized", $expr: { $eq: [{ $sum: "$employees.paidMinor" }, 0] } }, { $set: { state: "reversed", reversedBy: revision._id, reversedAt: new Date() } }, { new: true });
    if (!original) {
      const recoverable = await PayrollRunModel.exists({ _id: revision.revisionOf, organizationId: orgId, state: "reversed", reversedBy: revision._id });
      if (!recoverable) throw new AppError("CONFLICT", "The original run was paid or changed; this revision cannot replace it", 409);
    } else {
      await recordAudit({ actor, action: "payroll.run_reversed", entityType: "payroll_run", entityId: original._id.toString(), organizationId: orgId, before: { state: "finalized" }, after: { state: "reversed", replacedBy: revision._id.toString() }, meta });
    }
  }
  return transitionPayrollRun(actor, orgId, id, "approved", "finalized", "payroll.run_finalized", meta);
}

export async function recordPayrollPayment(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof payrollPaymentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const employeeId = new Types.ObjectId(input.employeeId);
  const payment = { employeeId, amountMinor: input.amountMinor, reference: input.reference ?? "", recordedBy: new Types.ObjectId(actor.userId), recordedAt: new Date() };
  const run = await PayrollRunModel.findOneAndUpdate({ _id: id, organizationId: orgId, state: { $in: ["finalized", "partially_paid"] }, $expr: { $gt: [{ $size: { $filter: { input: "$employees", as: "employee", cond: { $and: [{ $eq: ["$$employee.employeeId", employeeId] }, { $lte: ["$$employee.paidMinor", { $subtract: ["$$employee.netPayMinor", input.amountMinor] }] }] } } } }, 0] } }, [
    { $set: { employees: { $map: { input: "$employees", as: "employee", in: { $cond: [{ $eq: ["$$employee.employeeId", employeeId] }, { $mergeObjects: ["$$employee", { paidMinor: { $add: ["$$employee.paidMinor", input.amountMinor] } }] }, "$$employee"] } } }, payments: { $concatArrays: ["$payments", [payment]] } } },
    { $set: { state: { $cond: [{ $eq: [{ $sum: "$employees.paidMinor" }, { $sum: "$employees.netPayMinor" }] }, "paid", "partially_paid"] } } },
  ], { new: true });
  if (!run) throw new AppError("CONFLICT", "Payroll must be finalized and payment cannot exceed the remaining employee balance", 409);
  await recordAudit({ actor, action: "payroll.payment_recorded", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { employeeId: input.employeeId, amountMinor: input.amountMinor, reference: payment.reference }, meta });
  return { id, employeeId: input.employeeId, amountMinor: input.amountMinor, state: run.state };
}
