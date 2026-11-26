import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import { escapeLike, isDuplicateKey, withMongoId } from "../../common/utils/db.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { db, type DbOrTx } from "../../database/connection.js";
import {
  attendanceAdjustments, attendancePolicies, attendanceRecords, compensationAssignments, compensationComponents, dailyEarnings, departments, designations,
  leaveRequests as leaveRequestsTable, leaveTypes, officeLocations, overtimeEntries, overtimePolicies, payStructures, payrollRunEmployees, payrollRunPayments, payrollRuns,
  shiftAssignments, shiftSwaps, shifts as shiftsTable, users as usersTable, workforceEmployees,
  type PayrollAttendanceDay, type PayrollLine,
} from "../../database/schema.js";
import { calculateAttendanceBaseMinor, calculateDailyAmountMinor, calculateOvertimeAmountMinor, calculatePercentageMinor, calculateProRataMinor } from "./payroll-calculations.js";
import { accessibleWorkforceEmployeeIds, assertWorkforceAssignmentWithinScope, assertWorkforceEmployeeAccessible, isWorkforceScopeRestricted, workforceEmployeeScopeCondition } from "./data-scope.js";
import type { compensationAssignmentSchema, componentSchema, dailyEarningCreateSchema, dailyEarningReviewSchema, departmentSchema, designationSchema, employeeCreateSchema, employeeUpdateSchema, overtimeCreateSchema, overtimePolicySchema, payStructureSchema, payrollPaymentSchema, payrollPeriodSchema, payrollRevisionSchema, shiftAssignmentSchema, shiftSchema, shiftSwapCreateSchema, shiftSwapReviewSchema, workforceListSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type EmployeeInput = z.infer<typeof employeeCreateSchema>;
type EmployeeUpdate = z.infer<typeof employeeUpdateSchema>;
type ListInput = z.infer<typeof workforceListSchema>;
type EmployeeRow = typeof workforceEmployees.$inferSelect;

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

// ---------- query helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
/** `{ $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] }` */
function openOrEndsOnOrAfter(column: AnyColumn, date: string) { return or(isNull(column), gte(column, date))!; }
/** `{ field: { $in: ids } }` with an empty-array guard. */
function inIds(column: AnyColumn, ids: string[]): SQL { return ids.length ? inArray(column, ids) : sql`false`; }
async function rowExists(query: Promise<unknown[]>) { return (await query).length > 0; }
/** Populated `employeeId` ref ("employeeNumber firstName lastName"), as Mongoose produced it. */
const employeeRefColumns = { _id: workforceEmployees.id, employeeNumber: workforceEmployees.employeeNumber, firstName: workforceEmployees.firstName, lastName: workforceEmployees.lastName };

/** Applies the old Mongoose setters (uppercase employee number, lowercase email, trim). */
function normalizeEmployeeFields<T extends Partial<EmployeeInput>>(input: T): T {
  const result: T = { ...input };
  if (typeof input.employeeNumber === "string") result.employeeNumber = input.employeeNumber.trim().toUpperCase();
  if (typeof input.email === "string") result.email = input.email.trim().toLowerCase();
  if (typeof input.firstName === "string") result.firstName = input.firstName.trim();
  if (typeof input.lastName === "string") result.lastName = input.lastName.trim();
  if (typeof input.phone === "string") result.phone = input.phone.trim();
  return result;
}

async function validateRelations(orgId: string, input: Partial<EmployeeInput>, employeeId?: string) {
  const checks: Promise<boolean>[] = [];
  if (input.userId) checks.push(rowExists(db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, input.userId), eq(usersTable.organizationId, orgId))).limit(1)));
  if (input.userId) checks.push(rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.userId, input.userId), employeeId ? ne(workforceEmployees.id, employeeId) : undefined)).limit(1)).then((linked) => !linked));
  if (input.departmentId) checks.push(rowExists(db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.organizationId, orgId))).limit(1)));
  if (input.designationId) checks.push(rowExists(db.select({ id: designations.id }).from(designations).where(and(eq(designations.id, input.designationId), eq(designations.organizationId, orgId))).limit(1)));
  if (input.reportingManagerId) checks.push(rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.reportingManagerId), eq(workforceEmployees.organizationId, orgId))).limit(1)));
  if (input.workLocationId) checks.push(rowExists(db.select({ id: officeLocations.id }).from(officeLocations).where(and(eq(officeLocations.id, input.workLocationId), eq(officeLocations.organizationId, orgId))).limit(1)));
  const results = await Promise.all(checks);
  if (results.some((result) => !result)) throw new AppError("VALIDATION_ERROR", "A linked employee, department, designation, user, or location was not found in this organization", 422);
}

function employeeView(employee: EmployeeRow) {
  return { id: employee.id, organizationId: employee.organizationId, userId: employee.userId ?? null,
    employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName, name: `${employee.firstName} ${employee.lastName}`.trim(),
    email: employee.email, phone: employee.phone, dateOfBirth: employee.dateOfBirth, joiningDate: employee.joiningDate, employmentType: employee.employmentType,
    status: employee.status, departmentId: employee.departmentId ?? null, designationId: employee.designationId ?? null,
    reportingManagerId: employee.reportingManagerId ?? null, workLocationId: employee.workLocationId ?? null, notes: employee.notes,
    createdAt: employee.createdAt, updatedAt: employee.updatedAt };
}

function employeeSearchCondition(search: string | undefined, columns: AnyColumn[]) {
  if (!search) return undefined;
  const pattern = `%${escapeLike(search)}%`;
  return or(...columns.map((column) => ilike(column, pattern)));
}

export async function listWorkforceEmployees(actor: AuthContext, orgId: string, query: ListInput) {
  const where = and(
    eq(workforceEmployees.organizationId, orgId),
    workforceEmployeeScopeCondition(actor),
    query.status ? eq(workforceEmployees.status, query.status) : undefined,
    query.departmentId ? eq(workforceEmployees.departmentId, query.departmentId) : undefined,
    query.employmentType ? eq(workforceEmployees.employmentType, query.employmentType) : undefined,
    employeeSearchCondition(query.search, [workforceEmployees.employeeNumber, workforceEmployees.firstName, workforceEmployees.lastName, workforceEmployees.email, workforceEmployees.phone]),
  );
  const [items, total] = await Promise.all([
    db.select().from(workforceEmployees).where(where).orderBy(asc(workforceEmployees.lastName), asc(workforceEmployees.firstName)).limit(query.limit).offset((query.page - 1) * query.limit),
    db.$count(workforceEmployees, where),
  ]);
  return { items: items.map(employeeView), meta: { page: query.page, limit: query.limit, total } };
}

export async function listWorkforceLoginAccounts(actor: AuthContext, orgId: string) {
  const linkedUserIds = db.select({ userId: workforceEmployees.userId }).from(workforceEmployees).where(and(eq(workforceEmployees.organizationId, orgId), isNotNull(workforceEmployees.userId)));
  const scope = workforceEmployeeScopeCondition(actor);
  const [users, scopedLinks] = await Promise.all([
    // Any team member login (not only the `employee` role) can be linked to an employee profile.
    // Linked accounts are always returned, even if disabled, so the edit form can show the current link.
    db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, status: usersTable.status }).from(usersTable)
      .where(and(eq(usersTable.organizationId, orgId), inArray(usersTable.role, TEAM_MEMBER_ROLES), or(eq(usersTable.status, "active"), inArray(usersTable.id, linkedUserIds))))
      .orderBy(asc(usersTable.name)),
    db.select({ id: workforceEmployees.id, userId: workforceEmployees.userId }).from(workforceEmployees)
      .where(and(eq(workforceEmployees.organizationId, orgId), isNotNull(workforceEmployees.userId), scope)),
  ]);
  const visibleUserIds = new Set(scopedLinks.map((item) => item.userId!));
  const linkedEmployeeByUser = new Map(scopedLinks.map((item) => [item.userId!, item.id]));
  return users.filter((user) => !scope || visibleUserIds.has(user.id)).map((user) => ({ id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, linkedEmployeeId: linkedEmployeeByUser.get(user.id) ?? null }));
}

const TEAM_MEMBER_ROLES = ["org_admin", "sub_admin", "accounts_manager", "field_recovery", "employee", "guard"];

/**
 * Converts existing team members (organization login accounts) into employee profiles.
 * Members already linked to a profile, or whose email already belongs to a profile, are skipped.
 * The login account email becomes the employee email and the account is linked to the new profile.
 */
export async function importTeamMembersAsEmployees(actor: AuthContext, orgId: string, meta: RequestMeta) {
  if (isWorkforceScopeRestricted(actor)) throw new AppError("FORBIDDEN", "Importing all team members requires organization-wide workforce access", 403);
  const [users, profiles] = await Promise.all([
    db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, createdAt: usersTable.createdAt }).from(usersTable)
      .where(and(eq(usersTable.organizationId, orgId), eq(usersTable.status, "active"), inArray(usersTable.role, TEAM_MEMBER_ROLES))).orderBy(asc(usersTable.createdAt)),
    db.select({ userId: workforceEmployees.userId, email: workforceEmployees.email, employeeNumber: workforceEmployees.employeeNumber }).from(workforceEmployees).where(eq(workforceEmployees.organizationId, orgId)),
  ]);
  const linkedUserIds = new Set(profiles.filter((item) => item.userId).map((item) => item.userId!));
  const profileEmails = new Set(profiles.map((item) => (item.email ?? "").toLowerCase()).filter(Boolean));
  const usedNumbers = new Set(profiles.map((item) => item.employeeNumber.toUpperCase()));
  let sequence = profiles.length;
  const nextNumber = () => { let candidate; do { sequence += 1; candidate = `EMP${String(sequence).padStart(4, "0")}`; } while (usedNumbers.has(candidate)); usedNumbers.add(candidate); return candidate; };
  const toCreate: Array<typeof workforceEmployees.$inferInsert> = [];
  let skipped = 0;
  for (const member of users) {
    const email = (member.email ?? "").trim().toLowerCase();
    if (linkedUserIds.has(member.id) || (email && profileEmails.has(email))) { skipped++; continue; }
    const [firstName, ...rest] = (member.name || email.split("@")[0] || "Employee").trim().split(/\s+/);
    toCreate.push({ organizationId: orgId, userId: member.id, employeeNumber: nextNumber(), firstName: firstName!, lastName: rest.join(" "), email, joiningDate: new Date(member.createdAt ?? Date.now()).toISOString().slice(0, 10), employmentType: "permanent", status: "active" });
  }
  const created = toCreate.length ? await db.transaction(async (tx) => {
    const inserted: Array<{ employeeNumber: string }> = [];
    for (let index = 0; index < toCreate.length; index += 500) inserted.push(...await tx.insert(workforceEmployees).values(toCreate.slice(index, index + 500)).returning({ employeeNumber: workforceEmployees.employeeNumber }));
    return inserted;
  }) : [];
  if (created.length) await recordAudit({ actor, action: "workforce.team_members_imported", entityType: "workforce_employee_import", entityId: orgId, organizationId: orgId, after: { createdCount: created.length, skippedCount: skipped, employeeNumbers: created.map((item) => item.employeeNumber) }, meta });
  return { createdCount: created.length, skippedCount: skipped };
}

export async function listPayrollEmployees(actor: AuthContext, orgId: string, query: ListInput) {
  const where = and(
    eq(workforceEmployees.organizationId, orgId),
    workforceEmployeeScopeCondition(actor),
    query.status ? eq(workforceEmployees.status, query.status) : undefined,
    employeeSearchCondition(query.search, [workforceEmployees.employeeNumber, workforceEmployees.firstName, workforceEmployees.lastName]),
  );
  const [items, total] = await Promise.all([
    db.select({ id: workforceEmployees.id, employeeNumber: workforceEmployees.employeeNumber, firstName: workforceEmployees.firstName, lastName: workforceEmployees.lastName, status: workforceEmployees.status }).from(workforceEmployees)
      .where(where).orderBy(asc(workforceEmployees.lastName), asc(workforceEmployees.firstName)).limit(query.limit).offset((query.page - 1) * query.limit),
    db.$count(workforceEmployees, where),
  ]);
  return { items: items.map((item) => ({ id: item.id, employeeNumber: item.employeeNumber, name: `${item.firstName} ${item.lastName}`.trim(), status: item.status })), meta: { page: query.page, limit: query.limit, total } };
}

export async function createWorkforceEmployee(actor: AuthContext, orgId: string, input: EmployeeInput, meta: RequestMeta) {
  if (input.reportingManagerId) await assertWorkforceEmployeeAccessible(orgId, actor, input.reportingManagerId);
  assertWorkforceAssignmentWithinScope(actor, input.departmentId, input.workLocationId);
  await validateRelations(orgId, input);
  let employee: EmployeeRow;
  try {
    [employee] = await db.insert(workforceEmployees).values({ ...normalizeEmployeeFields(input), organizationId: orgId }).returning() as [EmployeeRow];
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("CONFLICT", `Employee ID ${input.employeeNumber.toUpperCase()} is already in use. Enter a unique employee ID.`, 409);
    throw error;
  }
  await recordAudit({ actor, action: "workforce.employee_created", entityType: "workforce_employee", entityId: employee.id, organizationId: orgId, after: employeeView(employee), meta });
  return employeeView(employee);
}

export async function updateWorkforceEmployee(actor: AuthContext, orgId: string, id: string, input: EmployeeUpdate, meta: RequestMeta) {
  await validateRelations(orgId, input, id);
  await assertWorkforceEmployeeAccessible(orgId, actor, id);
  const [employee] = await db.select().from(workforceEmployees).where(and(eq(workforceEmployees.id, id), eq(workforceEmployees.organizationId, orgId))).limit(1);
  if (!employee) throw new AppError("NOT_FOUND", "Employee profile not found", 404);
  assertWorkforceAssignmentWithinScope(actor, input.departmentId ?? employee.departmentId, input.workLocationId ?? employee.workLocationId);
  const before = employeeView(employee);
  const [updated] = await db.update(workforceEmployees).set({ ...normalizeEmployeeFields(input), updatedAt: new Date() }).where(and(eq(workforceEmployees.id, id), eq(workforceEmployees.organizationId, orgId))).returning();
  if (!updated) throw new AppError("NOT_FOUND", "Employee profile not found", 404);
  await recordAudit({ actor, action: "workforce.employee_updated", entityType: "workforce_employee", entityId: id, organizationId: orgId, before, after: employeeView(updated), meta });
  return employeeView(updated);
}

export async function listDepartments(orgId: string) {
  const rows = await db.select().from(departments).where(eq(departments.organizationId, orgId)).orderBy(asc(departments.name));
  return rows.map(withMongoId);
}
export async function saveDepartment(actor: AuthContext, orgId: string, input: z.infer<typeof departmentSchema>, id: string | undefined, meta: RequestMeta) {
  if (input.managerEmployeeId && !await rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.managerEmployeeId), eq(workforceEmployees.organizationId, orgId))).limit(1))) throw new AppError("NOT_FOUND", "Department manager was not found", 404);
  const values = { ...input, name: input.name.trim(), ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}) };
  const [record] = id
    ? await db.update(departments).set(values).where(and(eq(departments.id, id), eq(departments.organizationId, orgId))).returning()
    : await db.insert(departments).values({ ...values, organizationId: orgId }).returning();
  if (!record) throw new AppError("NOT_FOUND", "Department not found", 404);
  await recordAudit({ actor, action: id ? "workforce.department_updated" : "workforce.department_created", entityType: "department", entityId: record.id, organizationId: orgId, after: input, meta });
  return { id: record.id, name: record.name, code: record.code, managerEmployeeId: record.managerEmployeeId ?? null, status: record.status };
}

export async function listDesignations(orgId: string) {
  const rows = await db.select().from(designations).where(eq(designations.organizationId, orgId)).orderBy(asc(designations.name));
  return rows.map(withMongoId);
}
export async function saveDesignation(actor: AuthContext, orgId: string, input: z.infer<typeof designationSchema>, id: string | undefined, meta: RequestMeta) {
  const values = { ...input, name: input.name.trim(), ...(input.description !== undefined ? { description: input.description.trim() } : {}) };
  const [record] = id
    ? await db.update(designations).set(values).where(and(eq(designations.id, id), eq(designations.organizationId, orgId))).returning()
    : await db.insert(designations).values({ ...values, organizationId: orgId }).returning();
  if (!record) throw new AppError("NOT_FOUND", "Designation not found", 404);
  await recordAudit({ actor, action: id ? "workforce.designation_updated" : "workforce.designation_created", entityType: "designation", entityId: record.id, organizationId: orgId, after: input, meta });
  return { id: record.id, name: record.name, description: record.description, status: record.status };
}

export async function listShifts(_actor: AuthContext, orgId: string, section: "shifts" | "assignments" | "assignment-form" | "all" = "all") {
  const [shifts, assignments] = await Promise.all([
    section === "shifts" || section === "assignment-form" || section === "all" ? db.select().from(shiftsTable).where(eq(shiftsTable.organizationId, orgId)).orderBy(desc(shiftsTable.effectiveFrom), asc(shiftsTable.name)) : Promise.resolve([]),
    section === "assignments" || section === "assignment-form" || section === "all"
      ? db.select({ id: shiftAssignments.id, effectiveFrom: shiftAssignments.effectiveFrom, effectiveTo: shiftAssignments.effectiveTo, employee: employeeRefColumns, shift: { _id: shiftsTable.id, name: shiftsTable.name } })
        .from(shiftAssignments)
        .leftJoin(workforceEmployees, eq(workforceEmployees.id, shiftAssignments.employeeId))
        .leftJoin(shiftsTable, eq(shiftsTable.id, shiftAssignments.shiftId))
        .where(and(eq(shiftAssignments.organizationId, orgId), openOrEndsOnOrAfter(shiftAssignments.effectiveTo, today())))
        .orderBy(desc(shiftAssignments.effectiveFrom))
      : Promise.resolve([]),
  ]);
  return { shifts: shifts.map((shift) => ({ id: shift.id, name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: shift.crossesMidnight, flexibleWindowMinutes: shift.flexibleWindowMinutes, breaks: shift.breaks, weeklyOffs: shift.weeklyOffs, effectiveFrom: shift.effectiveFrom, effectiveTo: shift.effectiveTo, status: shift.status })), assignments: assignments.map((item) => ({ id: item.id, employee: item.employee ?? null, shift: item.shift ?? null, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo })) };
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
  const [shift] = await db.insert(shiftsTable).values({ ...input, crossesMidnight, organizationId: orgId }).returning();
  await recordAudit({ actor, action: "workforce.shift_created", entityType: "workforce_shift", entityId: shift!.id, organizationId: orgId, after: input, meta });
  return { id: shift!.id, name: shift!.name, shiftType: shift!.shiftType, startTime: shift!.startTime, endTime: shift!.endTime, crossesMidnight: shift!.crossesMidnight, breaks: shift!.breaks, weeklyOffs: shift!.weeklyOffs, effectiveFrom: shift!.effectiveFrom, effectiveTo: shift!.effectiveTo, status: shift!.status };
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
  const [shift] = await db.update(shiftsTable).set({ ...input, crossesMidnight }).where(and(eq(shiftsTable.id, id), eq(shiftsTable.organizationId, orgId))).returning();
  if (!shift) throw new AppError("NOT_FOUND", "Shift not found", 404);
  await recordAudit({ actor, action: "workforce.shift_updated", entityType: "workforce_shift", entityId: id, organizationId: orgId, after: input, meta });
  return { id, name: shift.name, shiftType: shift.shiftType, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: shift.crossesMidnight, breaks: shift.breaks, weeklyOffs: shift.weeklyOffs, effectiveFrom: shift.effectiveFrom, effectiveTo: shift.effectiveTo, status: shift.status };
}

export async function deleteShift(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const [shift] = await db.select({ id: shiftsTable.id, name: shiftsTable.name }).from(shiftsTable).where(and(eq(shiftsTable.id, id), eq(shiftsTable.organizationId, orgId))).limit(1);
  if (!shift) throw new AppError("NOT_FOUND", "Shift not found", 404);
  if (await rowExists(db.select({ id: shiftAssignments.id }).from(shiftAssignments).where(and(eq(shiftAssignments.organizationId, orgId), eq(shiftAssignments.shiftId, id))).limit(1))) throw new AppError("CONFLICT", "This shift is assigned to employees. End or move those assignments before deleting it.", 409);
  await db.delete(shiftsTable).where(and(eq(shiftsTable.id, id), eq(shiftsTable.organizationId, orgId)));
  await recordAudit({ actor, action: "workforce.shift_deleted", entityType: "workforce_shift", entityId: id, organizationId: orgId, before: { name: shift.name }, meta });
  return { id, deleted: true };
}

export async function assignShift(actor: AuthContext, orgId: string, input: z.infer<typeof shiftAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, shift] = await Promise.all([
    rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"))).limit(1)),
    rowExists(db.select({ id: shiftsTable.id }).from(shiftsTable).where(and(eq(shiftsTable.id, input.shiftId), eq(shiftsTable.organizationId, orgId), eq(shiftsTable.status, "active"), lte(shiftsTable.effectiveFrom, input.effectiveFrom), openOrEndsOnOrAfter(shiftsTable.effectiveTo, input.effectiveFrom))).limit(1)),
  ]);
  if (!employee || !shift) throw new AppError("NOT_FOUND", "Active employee or effective shift not found in this organization", 404);
  const assignment = await db.transaction(async (tx) => {
    const overlaps = await tx.select({ id: shiftAssignments.id, effectiveFrom: shiftAssignments.effectiveFrom }).from(shiftAssignments)
      .where(and(eq(shiftAssignments.organizationId, orgId), eq(shiftAssignments.employeeId, input.employeeId), lte(shiftAssignments.effectiveFrom, input.effectiveTo ?? "9999-12-31"), openOrEndsOnOrAfter(shiftAssignments.effectiveTo, input.effectiveFrom)));
    for (const previous of overlaps) {
      if (previous.effectiveFrom >= input.effectiveFrom) throw new AppError("CONFLICT", "A later shift assignment already exists; assignments cannot be backdated across it", 409);
      await tx.update(shiftAssignments).set({ effectiveTo: dayBefore(input.effectiveFrom) }).where(eq(shiftAssignments.id, previous.id));
    }
    const [created] = await tx.insert(shiftAssignments).values({ employeeId: input.employeeId, shiftId: input.shiftId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, organizationId: orgId, assignedBy: actor.userId }).returning({ id: shiftAssignments.id });
    return created!;
  });
  await recordAudit({ actor, action: "workforce.shift_assigned", entityType: "workforce_shift_assignment", entityId: assignment.id, organizationId: orgId, after: input, meta });
  return { id: assignment.id, employeeId: input.employeeId, shiftId: input.shiftId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null };
}

type ShiftSwapRow = typeof shiftSwaps.$inferSelect;
type SwapEmployeeRef = { id: string; employeeNumber: string; firstName: string; lastName: string };
type SwapShiftRef = { id: string; name: string; startTime: string; endTime: string; crossesMidnight: boolean };
/** Populated refs are given for list responses; unpopulated responses keep the old `{ id }` / `null` shape. */
function presentShiftSwap(swap: ShiftSwapRow, populated?: { employees: Map<string, SwapEmployeeRef>; shifts: Map<string, SwapShiftRef> }) {
  const employeeRef = (employeeId: string) => {
    if (!populated) return { id: employeeId };
    const employee = populated.employees.get(employeeId);
    return employee ? { id: employee.id, employeeNumber: employee.employeeNumber, name: `${employee.firstName} ${employee.lastName}`.trim() } : { id: undefined };
  };
  const shiftRef = (shiftId: string | null) => {
    const shift = populated && shiftId ? populated.shifts.get(shiftId) : undefined;
    return shift ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime, crossesMidnight: Boolean(shift.crossesMidnight) } : null;
  };
  return {
    id: swap.id,
    shiftDate: swap.shiftDate,
    reason: swap.reason,
    status: swap.status,
    requesterEmployee: employeeRef(swap.requesterEmployeeId),
    targetEmployee: employeeRef(swap.targetEmployeeId),
    requesterShift: shiftRef(swap.requesterShiftId),
    targetShift: shiftRef(swap.targetShiftId),
    reviewedBy: swap.reviewedBy ?? null,
    reviewedAt: swap.reviewedAt ?? null,
    reviewComment: swap.reviewComment ?? "",
    createdAt: swap.createdAt,
  };
}

async function findEffectiveShiftAssignment(orgId: string, employeeId: string, date: string) {
  const [assignment] = await db.select({ shiftId: shiftAssignments.shiftId }).from(shiftAssignments)
    .where(and(eq(shiftAssignments.organizationId, orgId), eq(shiftAssignments.employeeId, employeeId), lte(shiftAssignments.effectiveFrom, date), openOrEndsOnOrAfter(shiftAssignments.effectiveTo, date)))
    .limit(1);
  return assignment ?? null;
}

async function findEmployeeProfileForUser(orgId: string, userId: string, activeOnly = false) {
  const [profile] = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.userId, userId), activeOnly ? eq(workforceEmployees.status, "active") : undefined)).limit(1);
  return profile ?? null;
}

export async function requestShiftSwap(
  actor: AuthContext,
  orgId: string,
  input: z.infer<typeof shiftSwapCreateSchema>,
  meta: RequestMeta,
) {
  const requester = await findEmployeeProfileForUser(orgId, actor.userId, true);
  if (!requester) throw new AppError("NOT_FOUND", "Active employee profile not found for current user", 404);
  if (requester.id === input.targetEmployeeId) {
    throw new AppError("VALIDATION_ERROR", "Cannot request a shift swap with yourself", 422);
  }
  const [target] = await db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.targetEmployeeId), eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"))).limit(1);
  if (!target) throw new AppError("NOT_FOUND", "Target employee not found or inactive", 404);

  const existing = await rowExists(db.select({ id: shiftSwaps.id }).from(shiftSwaps).where(and(
    eq(shiftSwaps.organizationId, orgId),
    eq(shiftSwaps.shiftDate, input.shiftDate),
    eq(shiftSwaps.status, "pending"),
    or(eq(shiftSwaps.requesterEmployeeId, requester.id), eq(shiftSwaps.targetEmployeeId, requester.id)),
  )).limit(1));
  if (existing) throw new AppError("CONFLICT", "You already have a pending shift swap request for this date", 409);

  const [requesterAssignment, targetAssignment] = await Promise.all([
    findEffectiveShiftAssignment(orgId, requester.id, input.shiftDate),
    findEffectiveShiftAssignment(orgId, target.id, input.shiftDate),
  ]);

  if (!requesterAssignment && !targetAssignment) {
    throw new AppError("VALIDATION_ERROR", "At least one employee must have an assigned shift on this date to swap", 422);
  }

  const [swap] = await db.insert(shiftSwaps).values({
    organizationId: orgId,
    requesterEmployeeId: requester.id,
    targetEmployeeId: target.id,
    requesterShiftId: requesterAssignment?.shiftId ?? null,
    targetShiftId: targetAssignment?.shiftId ?? null,
    shiftDate: input.shiftDate,
    reason: input.reason.trim(),
    status: "pending",
  }).returning();

  await recordAudit({
    actor,
    action: "workforce.shift_swap_requested",
    entityType: "workforce_shift_swap",
    entityId: swap!.id,
    organizationId: orgId,
    after: { ...input, requesterEmployeeId: requester.id },
    meta,
  });

  return presentShiftSwap(swap!);
}

export async function listShiftSwaps(actor: AuthContext, orgId: string, mineOnly = false) {
  let ownFilter: SQL | undefined;
  const profile = await findEmployeeProfileForUser(orgId, actor.userId);
  if (mineOnly || actor.role === "employee") {
    if (!profile) return [];
    ownFilter = or(eq(shiftSwaps.requesterEmployeeId, profile.id), eq(shiftSwaps.targetEmployeeId, profile.id));
  }

  const swaps = await db.select().from(shiftSwaps).where(and(eq(shiftSwaps.organizationId, orgId), ownFilter)).orderBy(desc(shiftSwaps.shiftDate), desc(shiftSwaps.createdAt));
  const employeeIds = [...new Set(swaps.flatMap((swap) => [swap.requesterEmployeeId, swap.targetEmployeeId]))];
  const shiftIds = [...new Set(swaps.flatMap((swap) => [swap.requesterShiftId, swap.targetShiftId]).filter((value): value is string => Boolean(value)))];
  const [employees, shifts] = await Promise.all([
    employeeIds.length ? db.select({ id: workforceEmployees.id, employeeNumber: workforceEmployees.employeeNumber, firstName: workforceEmployees.firstName, lastName: workforceEmployees.lastName }).from(workforceEmployees).where(inArray(workforceEmployees.id, employeeIds)) : Promise.resolve([]),
    shiftIds.length ? db.select({ id: shiftsTable.id, name: shiftsTable.name, startTime: shiftsTable.startTime, endTime: shiftsTable.endTime, crossesMidnight: shiftsTable.crossesMidnight }).from(shiftsTable).where(inArray(shiftsTable.id, shiftIds)) : Promise.resolve([]),
  ]);
  const populated = { employees: new Map(employees.map((item) => [item.id, item])), shifts: new Map(shifts.map((item) => [item.id, item])) };
  return swaps.map((swap) => presentShiftSwap(swap, populated));
}

export async function reviewShiftSwap(
  actor: AuthContext,
  orgId: string,
  swapId: string,
  input: z.infer<typeof shiftSwapReviewSchema>,
  meta: RequestMeta,
) {
  const [swap] = await db.update(shiftSwaps)
    .set({ status: input.decision, reviewedBy: actor.userId, reviewedAt: new Date(), reviewComment: input.comment ?? "" })
    .where(and(eq(shiftSwaps.id, swapId), eq(shiftSwaps.organizationId, orgId), eq(shiftSwaps.status, "pending")))
    .returning();
  if (!swap) throw new AppError("NOT_FOUND", "Pending shift swap request not found", 404);

  await recordAudit({
    actor,
    action: `workforce.shift_swap_${input.decision}`,
    entityType: "workforce_shift_swap",
    entityId: swap.id,
    organizationId: orgId,
    after: { status: swap.status, reviewComment: swap.reviewComment },
    meta,
  });

  return presentShiftSwap(swap);
}

export async function cancelShiftSwap(actor: AuthContext, orgId: string, swapId: string, meta: RequestMeta) {
  const profile = await findEmployeeProfileForUser(orgId, actor.userId);
  const [swap] = await db.select({ id: shiftSwaps.id, requesterEmployeeId: shiftSwaps.requesterEmployeeId }).from(shiftSwaps).where(and(eq(shiftSwaps.id, swapId), eq(shiftSwaps.organizationId, orgId), eq(shiftSwaps.status, "pending"))).limit(1);
  if (!swap) throw new AppError("NOT_FOUND", "Pending shift swap request not found", 404);
  if (actor.role !== "org_admin" && (!profile || swap.requesterEmployeeId !== profile.id)) {
    throw new AppError("FORBIDDEN", "Only the requester or an administrator can cancel this swap request", 403);
  }
  await db.update(shiftSwaps).set({ status: "cancelled" }).where(eq(shiftSwaps.id, swap.id));
  await recordAudit({
    actor,
    action: "workforce.shift_swap_cancelled",
    entityType: "workforce_shift_swap",
    entityId: swap.id,
    organizationId: orgId,
    meta,
  });
  return { id: swap.id, status: "cancelled" };
}

export async function listCompensation(actor: AuthContext, orgId: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const [components, structures, assignments] = await Promise.all([
    db.select().from(compensationComponents).where(eq(compensationComponents.organizationId, orgId)).orderBy(asc(compensationComponents.name)),
    db.select().from(payStructures).where(eq(payStructures.organizationId, orgId)).orderBy(desc(payStructures.effectiveFrom), asc(payStructures.name)),
    db.select({
      id: compensationAssignments.id, effectiveFrom: compensationAssignments.effectiveFrom, effectiveTo: compensationAssignments.effectiveTo,
      employee: employeeRefColumns,
      structure: { _id: payStructures.id, name: payStructures.name, mode: payStructures.mode, payBasis: payStructures.payBasis, baseRateMinor: payStructures.baseRateMinor },
    }).from(compensationAssignments)
      .leftJoin(workforceEmployees, eq(workforceEmployees.id, compensationAssignments.employeeId))
      .leftJoin(payStructures, eq(payStructures.id, compensationAssignments.structureId))
      .where(and(eq(compensationAssignments.organizationId, orgId), employeeIds ? inIds(compensationAssignments.employeeId, employeeIds) : undefined, openOrEndsOnOrAfter(compensationAssignments.effectiveTo, today())))
      .orderBy(desc(compensationAssignments.effectiveFrom)),
  ]);
  return { components: components.map((item) => ({ id: item.id, code: item.code, name: item.name, kind: item.kind, calculation: item.calculation, amountMinor: item.amountMinor, rateBasisPoints: item.rateBasisPoints, basisComponentCode: item.basisComponentCode, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), structures: structures.map((item) => ({ id: item.id, name: item.name, mode: item.mode, payBasis: item.payBasis, baseRateMinor: item.baseRateMinor, components: item.components, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), assignments: assignments.map((item) => ({ id: item.id, employee: item.employee ?? null, structure: item.structure ?? null, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo })) };
}

export async function createCompensationComponent(actor: AuthContext, orgId: string, input: z.infer<typeof componentSchema>, meta: RequestMeta) {
  const [component] = await db.insert(compensationComponents).values({ ...input, code: input.code.trim().toUpperCase(), name: input.name.trim(), organizationId: orgId }).returning({ id: compensationComponents.id });
  await recordAudit({ actor, action: "payroll.component_created", entityType: "compensation_component", entityId: component!.id, organizationId: orgId, after: input, meta });
  return { id: component!.id, ...input };
}

/** Active components effective on `date`. Ordered by creation to mirror Mongo's natural order. */
async function loadStructureLines(orgId: string, componentIds: string[], effectiveFrom: string) {
  const components = componentIds.length ? await db.select().from(compensationComponents).where(and(inArray(compensationComponents.id, componentIds), eq(compensationComponents.organizationId, orgId), eq(compensationComponents.status, "active"), lte(compensationComponents.effectiveFrom, effectiveFrom), openOrEndsOnOrAfter(compensationComponents.effectiveTo, effectiveFrom))).orderBy(asc(compensationComponents.createdAt), asc(compensationComponents.id)) : [];
  if (components.length !== componentIds.length) throw new AppError("VALIDATION_ERROR", "All selected components must be active for this organization and effective date", 422);
  const lines = components.map((component) => ({ componentId: component.id, code: component.code, name: component.name, kind: component.kind, calculation: component.calculation, amountMinor: component.amountMinor, rateBasisPoints: component.rateBasisPoints, basisComponentCode: component.basisComponentCode }));
  for (const line of lines) if (line.calculation === "percentage" && line.basisComponentCode !== "BASE" && !lines.some((other) => other.code === line.basisComponentCode)) throw new AppError("VALIDATION_ERROR", `Unknown percentage basis: ${line.basisComponentCode}`, 422);
  return lines;
}

export async function createPayStructure(actor: AuthContext, orgId: string, input: z.infer<typeof payStructureSchema>, meta: RequestMeta) {
  const lines = await loadStructureLines(orgId, input.componentIds, input.effectiveFrom);
  const { componentIds: _componentIds, ...fields } = input;
  const [structure] = await db.insert(payStructures).values({ ...fields, name: fields.name.trim(), components: lines, organizationId: orgId }).returning();
  await recordAudit({ actor, action: "payroll.structure_created", entityType: "pay_structure", entityId: structure!.id, organizationId: orgId, after: { ...input, components: lines }, meta });
  return { id: structure!.id, name: structure!.name, mode: structure!.mode, payBasis: structure!.payBasis, baseRateMinor: structure!.baseRateMinor, components: structure!.components, effectiveFrom: structure!.effectiveFrom, status: structure!.status };
}

export async function updatePayStructure(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof payStructureSchema>, meta: RequestMeta) {
  const lines = await loadStructureLines(orgId, input.componentIds, input.effectiveFrom);
  const { componentIds: _componentIds, ...fields } = input;
  const [structure] = await db.update(payStructures).set({ ...fields, name: fields.name.trim(), components: lines }).where(and(eq(payStructures.id, id), eq(payStructures.organizationId, orgId))).returning();
  if (!structure) throw new AppError("NOT_FOUND", "Pay structure not found", 404);
  await recordAudit({ actor, action: "payroll.structure_updated", entityType: "pay_structure", entityId: id, organizationId: orgId, after: { ...input, components: lines }, meta });
  return { id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, status: structure.status };
}

export async function deletePayStructure(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  if (await rowExists(db.select({ id: compensationAssignments.id }).from(compensationAssignments).where(and(eq(compensationAssignments.organizationId, orgId), eq(compensationAssignments.structureId, id))).limit(1))) throw new AppError("CONFLICT", "This pay structure is assigned to an employee and cannot be deleted. Mark it inactive instead.", 409);
  const [structure] = await db.delete(payStructures).where(and(eq(payStructures.id, id), eq(payStructures.organizationId, orgId))).returning({ name: payStructures.name });
  if (!structure) throw new AppError("NOT_FOUND", "Pay structure not found", 404);
  await recordAudit({ actor, action: "payroll.structure_deleted", entityType: "pay_structure", entityId: id, organizationId: orgId, before: { name: structure.name }, meta });
  return { id, deleted: true };
}

async function findEffectivePayStructure(orgId: string, structureId: string, effectiveFrom: string) {
  const [structure] = await db.select().from(payStructures).where(and(eq(payStructures.id, structureId), eq(payStructures.organizationId, orgId), eq(payStructures.status, "active"), lte(payStructures.effectiveFrom, effectiveFrom), openOrEndsOnOrAfter(payStructures.effectiveTo, effectiveFrom))).limit(1);
  return structure ?? null;
}

function structureRateSnapshot(structure: typeof payStructures.$inferSelect) {
  return { structureId: structure.id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, capturedAt: new Date().toISOString() };
}

export async function assignCompensation(actor: AuthContext, orgId: string, input: z.infer<typeof compensationAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, structure] = await Promise.all([
    rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"))).limit(1)),
    findEffectivePayStructure(orgId, input.structureId, input.effectiveFrom),
  ]);
  if (!employee || !structure) throw new AppError("NOT_FOUND", "Active employee or effective pay structure not found in this organization", 404);
  const assignment = await db.transaction(async (tx) => {
    const overlaps = await tx.select({ id: compensationAssignments.id, effectiveFrom: compensationAssignments.effectiveFrom }).from(compensationAssignments)
      .where(and(eq(compensationAssignments.organizationId, orgId), eq(compensationAssignments.employeeId, input.employeeId), lte(compensationAssignments.effectiveFrom, input.effectiveTo ?? "9999-12-31"), openOrEndsOnOrAfter(compensationAssignments.effectiveTo, input.effectiveFrom)));
    for (const previous of overlaps) {
      if (previous.effectiveFrom >= input.effectiveFrom) throw new AppError("CONFLICT", "A later compensation assignment already exists; assignments cannot be backdated across it", 409);
      await tx.update(compensationAssignments).set({ effectiveTo: dayBefore(input.effectiveFrom) }).where(eq(compensationAssignments.id, previous.id));
    }
    const [created] = await tx.insert(compensationAssignments).values({ employeeId: input.employeeId, structureId: input.structureId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, organizationId: orgId, assignedBy: actor.userId, rateSnapshot: structureRateSnapshot(structure) }).returning({ id: compensationAssignments.id, rateSnapshot: compensationAssignments.rateSnapshot });
    return created!;
  });
  await recordAudit({ actor, action: "payroll.compensation_assigned", entityType: "compensation_assignment", entityId: assignment.id, organizationId: orgId, after: input, meta });
  return { id: assignment.id, employeeId: input.employeeId, structureId: input.structureId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, rateSnapshot: assignment.rateSnapshot };
}

export async function updateCompensationAssignment(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof compensationAssignmentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee, structure, current] = await Promise.all([
    rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"))).limit(1)),
    findEffectivePayStructure(orgId, input.structureId, input.effectiveFrom),
    rowExists(db.select({ id: compensationAssignments.id }).from(compensationAssignments).where(and(eq(compensationAssignments.id, id), eq(compensationAssignments.organizationId, orgId))).limit(1)),
  ]);
  if (!employee || !structure || !current) throw new AppError("NOT_FOUND", "Employee, pay structure, or assignment was not found", 404);
  if (await rowExists(db.select({ id: compensationAssignments.id }).from(compensationAssignments).where(and(eq(compensationAssignments.organizationId, orgId), ne(compensationAssignments.id, id), eq(compensationAssignments.employeeId, input.employeeId), lte(compensationAssignments.effectiveFrom, input.effectiveTo ?? "9999-12-31"), openOrEndsOnOrAfter(compensationAssignments.effectiveTo, input.effectiveFrom))).limit(1))) throw new AppError("CONFLICT", "This employee already has an overlapping pay assignment", 409);
  // Object.assign + save on the Mongoose document unset an omitted effectiveTo; keep that (null = open-ended).
  await db.update(compensationAssignments).set({ employeeId: input.employeeId, structureId: input.structureId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, rateSnapshot: structureRateSnapshot(structure) }).where(and(eq(compensationAssignments.id, id), eq(compensationAssignments.organizationId, orgId)));
  await recordAudit({ actor, action: "payroll.compensation_assignment_updated", entityType: "compensation_assignment", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteCompensationAssignment(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const [assignment] = await db.select().from(compensationAssignments).where(and(eq(compensationAssignments.id, id), eq(compensationAssignments.organizationId, orgId))).limit(1);
  if (!assignment) throw new AppError("NOT_FOUND", "Pay assignment not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, assignment.employeeId);
  const includedInRun = await rowExists(db.select({ id: payrollRuns.id }).from(payrollRuns)
    .innerJoin(payrollRunEmployees, eq(payrollRunEmployees.runId, payrollRuns.id))
    .where(and(eq(payrollRuns.organizationId, orgId), lte(payrollRuns.periodStart, assignment.effectiveTo ?? "9999-12-31"), gte(payrollRuns.periodEnd, assignment.effectiveFrom), eq(payrollRunEmployees.employeeId, assignment.employeeId)))
    .limit(1));
  if (includedInRun) throw new AppError("CONFLICT", "This assignment is included in a payroll run and cannot be deleted.", 409);
  await db.delete(compensationAssignments).where(eq(compensationAssignments.id, assignment.id));
  await recordAudit({ actor, action: "payroll.compensation_assignment_deleted", entityType: "compensation_assignment", entityId: id, organizationId: orgId, before: { employeeId: assignment.employeeId, structureId: assignment.structureId }, meta });
  return { id, deleted: true };
}

export async function listDailyEarnings(actor: AuthContext, orgId: string, from?: string, to?: string, employeeId?: string) {
  let employeeCondition: SQL | undefined;
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (visibleEmployeeIds) employeeCondition = inIds(dailyEarnings.employeeId, visibleEmployeeIds);
  if (employeeId) { await assertWorkforceEmployeeAccessible(orgId, actor, employeeId); employeeCondition = eq(dailyEarnings.employeeId, employeeId); }
  const entries = await db.select({ entry: dailyEarnings, employee: employeeRefColumns }).from(dailyEarnings)
    .leftJoin(workforceEmployees, eq(workforceEmployees.id, dailyEarnings.employeeId))
    .where(and(eq(dailyEarnings.organizationId, orgId), employeeCondition, from ? gte(dailyEarnings.earningDate, from) : undefined, to ? lte(dailyEarnings.earningDate, to) : undefined))
    .orderBy(desc(dailyEarnings.earningDate), desc(dailyEarnings.createdAt)).limit(500);
  return entries.map(({ entry, employee }) => ({ id: entry.id, employee: employee ?? null, earningDate: entry.earningDate, source: entry.source, description: entry.description, quantityThousandths: entry.quantityThousandths, rateMinor: entry.rateMinor, amountMinor: entry.amountMinor, currency: entry.currency, status: entry.status, adjustmentOf: entry.adjustmentOf ?? null, createdAt: entry.createdAt }));
}

export async function createDailyEarning(actor: AuthContext, orgId: string, currency: string, input: z.infer<typeof dailyEarningCreateSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  if (!await rowExists(db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, orgId))).limit(1))) throw new AppError("NOT_FOUND", "Employee profile not found", 404);
  const amountMinor = calculateDailyAmountMinor(input.quantityThousandths, input.rateMinor);
  const [entry] = await db.insert(dailyEarnings).values({ ...input, description: input.description.trim(), amountMinor, currency, organizationId: orgId, createdBy: actor.userId }).returning();
  await recordAudit({ actor, action: "payroll.daily_earning_created", entityType: "daily_earning", entityId: entry!.id, organizationId: orgId, after: { ...input, amountMinor, currency }, meta });
  return { id: entry!.id, employeeId: input.employeeId, earningDate: entry!.earningDate, amountMinor, rateMinor: entry!.rateMinor, quantityThousandths: entry!.quantityThousandths, status: entry!.status };
}

export async function reviewDailyEarning(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof dailyEarningReviewSchema>, meta: RequestMeta) {
  const [entry] = await db.select({ id: dailyEarnings.id, employeeId: dailyEarnings.employeeId }).from(dailyEarnings).where(and(eq(dailyEarnings.id, id), eq(dailyEarnings.organizationId, orgId), eq(dailyEarnings.status, "pending"))).limit(1);
  if (!entry) throw new AppError("NOT_FOUND", "Pending earning entry not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, entry.employeeId);
  const [updated] = await db.update(dailyEarnings).set({ status: input.decision }).where(and(eq(dailyEarnings.id, id), eq(dailyEarnings.organizationId, orgId), eq(dailyEarnings.status, "pending"))).returning({ status: dailyEarnings.status });
  if (!updated) throw new AppError("NOT_FOUND", "Pending earning entry not found", 404);
  await recordAudit({ actor, action: `payroll.daily_earning_${input.decision}`, entityType: "daily_earning", entityId: id, organizationId: orgId, after: { status: input.decision }, meta });
  return { id, status: updated.status };
}

export async function listOvertime(actor: AuthContext, orgId: string, section: "policies" | "entries" | "all" = "all") {
  const employeeIds = section === "policies" ? null : await accessibleWorkforceEmployeeIds(orgId, actor);
  const [policies, entries] = await Promise.all([
    section !== "entries" ? db.select().from(overtimePolicies).where(eq(overtimePolicies.organizationId, orgId)).orderBy(desc(overtimePolicies.effectiveFrom)) : Promise.resolve([]),
    section !== "policies"
      ? db.select({ entry: overtimeEntries, employee: employeeRefColumns }).from(overtimeEntries)
        .leftJoin(workforceEmployees, eq(workforceEmployees.id, overtimeEntries.employeeId))
        .where(and(eq(overtimeEntries.organizationId, orgId), employeeIds ? inIds(overtimeEntries.employeeId, employeeIds) : undefined))
        .orderBy(desc(overtimeEntries.workDate), desc(overtimeEntries.createdAt)).limit(500)
      : Promise.resolve([]),
  ]);
  return { policies: policies.map((item) => ({ id: item.id, name: item.name, calculation: item.calculation, multiplierBasisPoints: item.multiplierBasisPoints, hourlyRateMinor: item.hourlyRateMinor, minimumMinutes: item.minimumMinutes, roundingMinutes: item.roundingMinutes, maximumMinutesPerDay: item.maximumMinutesPerDay, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, status: item.status })), entries: entries.map(({ entry: item, employee }) => ({ id: item.id, employee: employee ?? null, workDate: item.workDate, actualMinutes: item.actualMinutes, calculatedMinutes: item.calculatedMinutes, approvedMinutes: item.approvedMinutes, hourlyRateMinor: item.hourlyRateMinor, payableAmountMinor: item.payableAmountMinor, status: item.status, reason: item.reason, policySnapshot: item.policySnapshot })) };
}

export async function createOvertimePolicy(actor: AuthContext, orgId: string, input: z.infer<typeof overtimePolicySchema>, meta: RequestMeta) {
  const [policy] = await db.insert(overtimePolicies).values({ ...input, name: input.name.trim(), organizationId: orgId }).returning({ id: overtimePolicies.id });
  await recordAudit({ actor, action: "overtime.policy_created", entityType: "overtime_policy", entityId: policy!.id, organizationId: orgId, after: input, meta });
  return { id: policy!.id, ...input };
}

export async function updateOvertimePolicy(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof overtimePolicySchema>, meta: RequestMeta) {
  const [policy] = await db.update(overtimePolicies).set({ ...input, name: input.name.trim() }).where(and(eq(overtimePolicies.id, id), eq(overtimePolicies.organizationId, orgId))).returning({ id: overtimePolicies.id });
  if (!policy) throw new AppError("NOT_FOUND", "Overtime policy not found", 404);
  await recordAudit({ actor, action: "overtime.policy_updated", entityType: "overtime_policy", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteOvertimePolicy(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  if (await rowExists(db.select({ id: overtimeEntries.id }).from(overtimeEntries).where(and(eq(overtimeEntries.organizationId, orgId), eq(overtimeEntries.policyId, id))).limit(1))) throw new AppError("CONFLICT", "This policy is used by overtime records and cannot be deleted. Mark it inactive instead.", 409);
  const [policy] = await db.delete(overtimePolicies).where(and(eq(overtimePolicies.id, id), eq(overtimePolicies.organizationId, orgId))).returning({ name: overtimePolicies.name });
  if (!policy) throw new AppError("NOT_FOUND", "Overtime policy not found", 404);
  await recordAudit({ actor, action: "overtime.policy_deleted", entityType: "overtime_policy", entityId: id, organizationId: orgId, before: { name: policy.name }, meta });
  return { id, deleted: true };
}

export async function createOvertimeEntry(actor: AuthContext, orgId: string, input: z.infer<typeof overtimeCreateSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const [employee] = await db.select({ id: workforceEmployees.id }).from(workforceEmployees).where(and(eq(workforceEmployees.id, input.employeeId), eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"))).limit(1);
  if (!employee) throw new AppError("NOT_FOUND", "Active employee profile not found", 404);
  const [policy] = await db.select().from(overtimePolicies).where(and(eq(overtimePolicies.id, input.policyId), eq(overtimePolicies.organizationId, orgId), eq(overtimePolicies.status, "active"), lte(overtimePolicies.effectiveFrom, input.workDate), openOrEndsOnOrAfter(overtimePolicies.effectiveTo, input.workDate))).limit(1);
  if (!policy) throw new AppError("VALIDATION_ERROR", "No active overtime policy applies to this date", 422);
  const rounded = Math.floor(input.actualMinutes / policy.roundingMinutes) * policy.roundingMinutes;
  const [existingMinutes] = await db.select({ minutes: sql<number>`coalesce(sum(${overtimeEntries.calculatedMinutes}), 0)`.mapWith(Number) }).from(overtimeEntries)
    .where(and(eq(overtimeEntries.organizationId, orgId), eq(overtimeEntries.employeeId, employee.id), eq(overtimeEntries.workDate, input.workDate), inArray(overtimeEntries.status, ["pending", "approved", "paid"])));
  const remainingDailyMinutes = Math.max(0, policy.maximumMinutesPerDay - (existingMinutes?.minutes ?? 0));
  const calculatedMinutes = Math.min(rounded >= policy.minimumMinutes ? rounded : 0, remainingDailyMinutes);
  let hourlyRateMinor = policy.hourlyRateMinor;
  if (policy.calculation === "multiplier") {
    const [assignment] = await db.select({ rateSnapshot: compensationAssignments.rateSnapshot }).from(compensationAssignments)
      .where(and(eq(compensationAssignments.organizationId, orgId), eq(compensationAssignments.employeeId, input.employeeId), lte(compensationAssignments.effectiveFrom, input.workDate), openOrEndsOnOrAfter(compensationAssignments.effectiveTo, input.workDate)))
      .orderBy(desc(compensationAssignments.effectiveFrom)).limit(1);
    if (assignment?.rateSnapshot?.payBasis === "hourly") hourlyRateMinor = assignment.rateSnapshot.baseRateMinor;
    if (hourlyRateMinor <= 0) throw new AppError("VALIDATION_ERROR", "Multiplier overtime requires an hourly pay assignment or a fixed hourly rate", 422);
  }
  const [entry] = await db.insert(overtimeEntries).values({ organizationId: orgId, employeeId: input.employeeId, workDate: input.workDate, actualMinutes: input.actualMinutes, calculatedMinutes, approvedMinutes: 0, policyId: policy.id, policySnapshot: { name: policy.name, calculation: policy.calculation, multiplierBasisPoints: policy.multiplierBasisPoints, hourlyRateMinor, roundingMinutes: policy.roundingMinutes, maximumMinutesPerDay: policy.maximumMinutesPerDay, capturedAt: new Date().toISOString() }, hourlyRateMinor, payableAmountMinor: 0, status: "pending", reason: input.reason.trim(), createdBy: actor.userId }).returning();
  await recordAudit({ actor, action: "overtime.entry_created", entityType: "overtime_entry", entityId: entry!.id, organizationId: orgId, after: { ...input, calculatedMinutes, policyId: policy.id }, meta });
  return { id: entry!.id, calculatedMinutes, status: entry!.status, actualMinutes: entry!.actualMinutes };
}

export async function reviewOvertime(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof dailyEarningReviewSchema>, meta: RequestMeta) {
  const [entry] = await db.select().from(overtimeEntries).where(and(eq(overtimeEntries.id, id), eq(overtimeEntries.organizationId, orgId), eq(overtimeEntries.status, "pending"))).limit(1);
  if (!entry) throw new AppError("NOT_FOUND", "Pending overtime record not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, entry.employeeId);
  let approvedMinutes = 0;
  let payableAmountMinor = 0;
  if (input.decision === "approved") {
    approvedMinutes = entry.calculatedMinutes;
    const multiplier = entry.policySnapshot.calculation === "multiplier" ? entry.policySnapshot.multiplierBasisPoints : 10000;
    payableAmountMinor = calculateOvertimeAmountMinor(approvedMinutes, entry.hourlyRateMinor, multiplier);
  }
  const [updated] = await db.update(overtimeEntries).set({ status: input.decision, reviewedBy: actor.userId, reviewedAt: new Date(), approvedMinutes, payableAmountMinor })
    .where(and(eq(overtimeEntries.id, id), eq(overtimeEntries.organizationId, orgId), eq(overtimeEntries.status, "pending"))).returning();
  if (!updated) throw new AppError("NOT_FOUND", "Pending overtime record not found", 404);
  await recordAudit({ actor, action: `overtime.entry_${input.decision}`, entityType: "overtime_entry", entityId: id, organizationId: orgId, after: { status: updated.status, approvedMinutes: updated.approvedMinutes, payableAmountMinor: updated.payableAmountMinor }, meta });
  return { id, status: updated.status, approvedMinutes: updated.approvedMinutes, payableAmountMinor: updated.payableAmountMinor };
}

// =====================================================================
// Payroll runs (employees[] / payments[] live in child tables)
// =====================================================================
type PayrollRunRow = typeof payrollRuns.$inferSelect;
type ChildMeta = "id" | "runId" | "organizationId" | "position";
/** One element of the former `payrollRuns.employees[]` array (original subdocument shape). */
type PayrollRunEmployee = Omit<typeof payrollRunEmployees.$inferSelect, ChildMeta>;
/** One element of the former `payrollRuns.payments[]` array (original subdocument shape). */
type PayrollRunPayment = Omit<typeof payrollRunPayments.$inferSelect, ChildMeta>;
type LoadedPayrollRun = PayrollRunRow & { employees: PayrollRunEmployee[]; payments: PayrollRunPayment[] };

function stripChildMeta<T extends Record<ChildMeta, unknown>>(row: T): Omit<T, ChildMeta> {
  const { id: _id, runId: _runId, organizationId: _organizationId, position: _position, ...element } = row;
  return element;
}

/** Attaches `employees` and `payments` arrays (original element shape and order) to run rows. */
async function attachRunChildren(runs: PayrollRunRow[], executor: DbOrTx = db): Promise<LoadedPayrollRun[]> {
  if (!runs.length) return [];
  const runIds = runs.map((run) => run.id);
  const [employeeRows, paymentRows] = await Promise.all([
    executor.select().from(payrollRunEmployees).where(inArray(payrollRunEmployees.runId, runIds)).orderBy(asc(payrollRunEmployees.runId), asc(payrollRunEmployees.position)),
    executor.select().from(payrollRunPayments).where(inArray(payrollRunPayments.runId, runIds)).orderBy(asc(payrollRunPayments.runId), asc(payrollRunPayments.position)),
  ]);
  const employeesByRun = new Map<string, PayrollRunEmployee[]>();
  for (const row of employeeRows) employeesByRun.set(row.runId, [...(employeesByRun.get(row.runId) ?? []), stripChildMeta(row)]);
  const paymentsByRun = new Map<string, PayrollRunPayment[]>();
  for (const row of paymentRows) paymentsByRun.set(row.runId, [...(paymentsByRun.get(row.runId) ?? []), stripChildMeta(row)]);
  return runs.map((run) => ({ ...run, employees: employeesByRun.get(run.id) ?? [], payments: paymentsByRun.get(run.id) ?? [] }));
}

async function loadPayrollRun(where: SQL | undefined, executor: DbOrTx = db): Promise<LoadedPayrollRun | null> {
  const rows = await executor.select().from(payrollRuns).where(where).limit(1);
  return (await attachRunChildren(rows, executor))[0] ?? null;
}

/** Inserts a run and its employees/payments children; call inside a transaction. */
async function insertPayrollRun(tx: DbOrTx, values: typeof payrollRuns.$inferInsert, employees: PayrollRunEmployee[], payments: PayrollRunPayment[] = []) {
  const [run] = await tx.insert(payrollRuns).values(values).returning();
  const organizationId = values.organizationId;
  for (let index = 0; index < employees.length; index += 500) {
    await tx.insert(payrollRunEmployees).values(employees.slice(index, index + 500).map((employee, offset) => ({ ...employee, runId: run!.id, organizationId, position: index + offset })));
  }
  if (payments.length) await tx.insert(payrollRunPayments).values(payments.map((payment, position) => ({ ...payment, runId: run!.id, organizationId, position })));
  return run!;
}

/** Throws unless every employee in the run is inside the actor's visible employee ids. */
async function assertPayrollRunWithinScope(orgId: string, runId: string, employeeIds: string[] | null, message: string) {
  if (!employeeIds) return;
  const [run] = await db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId))).limit(1);
  const visible = new Set(employeeIds);
  const runEmployees = run ? await db.select({ employeeId: payrollRunEmployees.employeeId }).from(payrollRunEmployees).where(eq(payrollRunEmployees.runId, run.id)) : [];
  if (!run || runEmployees.some((employee) => !visible.has(employee.employeeId))) throw new AppError("NOT_FOUND", message, 404);
}

export async function listPayrollRuns(actor: AuthContext, orgId: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const visible = employeeIds ? new Set(employeeIds) : null;
  const rows = await db.select().from(payrollRuns).where(eq(payrollRuns.organizationId, orgId)).orderBy(desc(payrollRuns.createdAt), desc(payrollRuns.periodStart), desc(payrollRuns.revision)).limit(200);
  const runs = await attachRunChildren(rows);
  return runs.filter((run) => !visible || run.employees.every((employee) => visible.has(employee.employeeId))).slice(0, 100).map((run) => ({ id: run.id, name: run.name || "Payroll", periodKey: run.periodKey, periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, state: run.state, employees: run.employees, payments: run.payments, totals: run.totals, revision: run.revision, revisionOf: run.revisionOf ?? null, revisionReason: run.revisionReason, reversedAt: run.reversedAt, createdAt: run.createdAt, finalizedAt: run.finalizedAt }));
}

export async function listOwnPayrollRuns(actor: AuthContext, orgId: string) {
  const employee = await findEmployeeProfileForUser(orgId, actor.userId);
  if (!employee) return [];
  const rows = await db.select({ run: payrollRuns, payslip: payrollRunEmployees }).from(payrollRuns)
    .innerJoin(payrollRunEmployees, and(eq(payrollRunEmployees.runId, payrollRuns.id), eq(payrollRunEmployees.employeeId, employee.id)))
    .where(and(eq(payrollRuns.organizationId, orgId), inArray(payrollRuns.state, ["finalized", "partially_paid", "paid"])))
    .orderBy(desc(payrollRuns.periodStart), asc(payrollRuns.id), asc(payrollRunEmployees.position));
  const seen = new Set<string>();
  // The first matching employee element per run is the payslip (as `employees.find(...)` did).
  return rows.filter(({ run }) => !seen.has(run.id) && Boolean(seen.add(run.id))).map(({ run, payslip }) => ({ id: run.id, name: run.name || "Payroll", periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, state: run.state, payslip: stripChildMeta(payslip) }));
}

function payrollPeriodKey(start: string, end: string) { return `${start}_${end}`; }

type ComputedLine = { code: string; name: string; kind: "earning" | "deduction" | "employer_contribution"; amountMinor: number; source: string; sourceId?: string | null };

export async function createPayrollRun(actor: AuthContext, orgId: string, currency: string, period: z.infer<typeof payrollPeriodSchema>, meta: RequestMeta) {
  const [attendancePolicy] = await db.select().from(attendancePolicies).where(eq(attendancePolicies.organizationId, orgId)).limit(1);
  const policyWeeklyOffs: number[] = Array.isArray(attendancePolicy?.weeklyHolidays) ? attendancePolicy.weeklyHolidays : [0, 6];
  const periodKey = `${payrollPeriodKey(period.periodStart, period.periodEnd)}_${randomUUID()}`;
  // Natural (insertion) order, as the unsorted Mongo query returned.
  const activeEmployees = await db.select({ employee: workforceEmployees, departmentName: departments.name, designationName: designations.name }).from(workforceEmployees)
    .leftJoin(departments, eq(departments.id, workforceEmployees.departmentId))
    .leftJoin(designations, eq(designations.id, workforceEmployees.designationId))
    .where(and(eq(workforceEmployees.organizationId, orgId), eq(workforceEmployees.status, "active"), workforceEmployeeScopeCondition(actor)))
    .orderBy(asc(workforceEmployees.createdAt), asc(workforceEmployees.id));
  const employeeRuns = [];
  for (const { employee, departmentName, designationName } of activeEmployees) {
    const [assignment] = await db.select().from(compensationAssignments)
      .where(and(eq(compensationAssignments.organizationId, orgId), eq(compensationAssignments.employeeId, employee.id), lte(compensationAssignments.effectiveFrom, period.periodEnd), openOrEndsOnOrAfter(compensationAssignments.effectiveTo, period.periodStart)))
      .orderBy(desc(compensationAssignments.effectiveFrom)).limit(1);
    const snapshot: Record<string, any> = assignment?.rateSnapshot ?? { payBasis: "none", baseRateMinor: 0, components: [] };
    const serviceStart = [period.periodStart, assignment?.effectiveFrom, employee.joiningDate].filter(Boolean).sort().at(-1)!;
    const serviceEnd = [period.periodEnd, assignment?.effectiveTo].filter(Boolean).sort()[0]!;
    const serviceDays = serviceEnd < serviceStart ? 0 : Math.round((Date.parse(`${serviceEnd}T00:00:00Z`) - Date.parse(`${serviceStart}T00:00:00Z`)) / 86400000) + 1;
    if (serviceDays === 0) continue;
    const periodBaseRateMinor = snapshot.payBasis === "monthly" ? prorateMonthlyRateByWorkdays(snapshot.baseRateMinor, serviceStart, serviceEnd, policyWeeklyOffs) : snapshot.baseRateMinor;
    const lines: ComputedLine[] = [];
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
    const [earnings, overtime, leaveRequests, attendance, adjustments, [shiftAssignment]] = await Promise.all([
      db.select().from(dailyEarnings).where(and(eq(dailyEarnings.organizationId, orgId), eq(dailyEarnings.employeeId, employee.id), gte(dailyEarnings.earningDate, period.periodStart), lte(dailyEarnings.earningDate, period.periodEnd), eq(dailyEarnings.status, "approved"))).orderBy(asc(dailyEarnings.createdAt), asc(dailyEarnings.id)),
      db.select().from(overtimeEntries).where(and(eq(overtimeEntries.organizationId, orgId), eq(overtimeEntries.employeeId, employee.id), gte(overtimeEntries.workDate, period.periodStart), lte(overtimeEntries.workDate, period.periodEnd), eq(overtimeEntries.status, "approved"), gt(overtimeEntries.approvedMinutes, 0))).orderBy(asc(overtimeEntries.createdAt), asc(overtimeEntries.id)),
      db.select({ startDate: leaveRequestsTable.startDate, endDate: leaveRequestsTable.endDate, days: leaveRequestsTable.days, leaveTypePaid: leaveTypes.paid }).from(leaveRequestsTable)
        .leftJoin(leaveTypes, eq(leaveTypes.id, leaveRequestsTable.leaveTypeId))
        .where(and(eq(leaveRequestsTable.organizationId, orgId), eq(leaveRequestsTable.employeeId, employee.id), eq(leaveRequestsTable.status, "approved"), lte(leaveRequestsTable.startDate, period.periodEnd), gte(leaveRequestsTable.endDate, period.periodStart)))
        .orderBy(asc(leaveRequestsTable.createdAt), asc(leaveRequestsTable.id)),
      employee.userId
        ? db.select({ attendanceDate: attendanceRecords.attendanceDate, totalWorkingMinutes: attendanceRecords.totalWorkingMinutes, checkIn: attendanceRecords.checkIn, checkOut: attendanceRecords.checkOut, halfDay: attendanceRecords.halfDay }).from(attendanceRecords)
          .where(and(eq(attendanceRecords.organizationId, orgId), eq(attendanceRecords.employeeId, employee.userId), gte(attendanceRecords.attendanceDate, serviceStart), lte(attendanceRecords.attendanceDate, serviceEnd), inArray(attendanceRecords.status, ["completed", "checked_in"])))
          .orderBy(asc(attendanceRecords.createdAt), asc(attendanceRecords.id))
        : Promise.resolve([]),
      db.select({ attendanceDate: attendanceAdjustments.attendanceDate, status: attendanceAdjustments.status, checkInAt: attendanceAdjustments.checkInAt, checkOutAt: attendanceAdjustments.checkOutAt }).from(attendanceAdjustments)
        .where(and(eq(attendanceAdjustments.organizationId, orgId), gte(attendanceAdjustments.attendanceDate, serviceStart), lte(attendanceAdjustments.attendanceDate, serviceEnd), or(eq(attendanceAdjustments.workforceEmployeeId, employee.id), ...(employee.userId ? [eq(attendanceAdjustments.employeeId, employee.userId)] : []))))
        .orderBy(asc(attendanceAdjustments.createdAt), asc(attendanceAdjustments.id)),
      db.select({ weeklyOffs: shiftsTable.weeklyOffs }).from(shiftAssignments)
        .leftJoin(shiftsTable, eq(shiftsTable.id, shiftAssignments.shiftId))
        .where(and(eq(shiftAssignments.organizationId, orgId), eq(shiftAssignments.employeeId, employee.id), lte(shiftAssignments.effectiveFrom, period.periodEnd), openOrEndsOnOrAfter(shiftAssignments.effectiveTo, period.periodStart)))
        .orderBy(desc(shiftAssignments.effectiveFrom)).limit(1),
    ]);
    const attendanceByDate = new Map<string, number>(attendance.map((record) => [record.attendanceDate, record.totalWorkingMinutes ?? 0]));
    const recordByDate = new Map(attendance.map((record) => [record.attendanceDate, record]));
    for (const adjustment of adjustments) {
      if (adjustment.status === "present" || adjustment.status === "half_day") {
        const minutes = adjustment.checkInAt && adjustment.checkOutAt ? Math.max(0, Math.floor((adjustment.checkOutAt.getTime() - adjustment.checkInAt.getTime()) / 60_000)) : 0;
        attendanceByDate.set(adjustment.attendanceDate, minutes || (adjustment.status === "half_day" ? Math.round((attendancePolicy?.halfDayHours ?? 4) * 60) : 0));
      } else attendanceByDate.delete(adjustment.attendanceDate);
    }
    const adjustmentByDate = new Map(adjustments.map((item) => [item.attendanceDate, item]));
    const attendanceRecordByDate = recordByDate;
    const overtimeByDate = new Map<string, number>();
    for (const item of overtime) overtimeByDate.set(item.workDate, (overtimeByDate.get(item.workDate) ?? 0) + item.payableAmountMinor);
    const shiftWeeklyOffs: number[] = shiftAssignment?.weeklyOffs ?? [0, 6];
    const weeklyOffs: number[] = Array.isArray(attendancePolicy?.weeklyHolidays) ? policyWeeklyOffs : shiftWeeklyOffs;
    const leaveByDate = new Map<string, { paid: boolean; units: number }>();
    for (const leave of leaveRequests) {
      const typeIsPaid = Boolean(leave.leaveTypePaid);
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
    // checkInAt/checkOutAt are ISO strings (JSONB); they serialize exactly as the former Date values did.
    const toIso = (value: Date | string | null | undefined) => value == null ? null : value instanceof Date ? value.toISOString() : value;
    const attendanceDays: PayrollAttendanceDay[] = [];
    let cursor = new Date(`${serviceStart}T00:00:00Z`); const serviceLast = new Date(`${serviceEnd}T00:00:00Z`); let scheduledWorkDays = 0;
    while (cursor <= serviceLast) {
      const date = cursor.toISOString().slice(0, 10); const dayOff = weeklyOffs.includes(cursor.getUTCDay());
      if (!dayOff) scheduledWorkDays++;
      const adjustment = adjustmentByDate.get(date); const record = attendanceRecordByDate.get(date);
      const leave = leaveByDate.get(date);
      const recordStatus = record?.halfDay ? "half_day" : record ? "present" : "missing";
      const status = dayOff ? "day_off" : adjustment?.status ?? (leave ? "leave" : recordStatus);
      attendanceDays.push({ date, status, leaveUnits: leave?.units, isPaidLeave: leave?.paid, checkInAt: toIso(adjustment?.checkInAt ?? record?.checkIn?.at ?? null), checkOutAt: toIso(adjustment?.checkOutAt ?? record?.checkOut?.at ?? null), overtimeAmountMinor: overtimeByDate.get(date) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const paidAttendanceUnits = attendanceDays.reduce((sum, day) => sum + (day.status === "present" ? 1 : day.status === "half_day" ? 0.5 : day.status === "leave" && day.isPaidLeave ? day.leaveUnits ?? 1 : 0), 0);
    const monthlyAttendanceFactor = scheduledWorkDays > 0 ? Math.min(1, paidAttendanceUnits / scheduledWorkDays) : 0;
    if (snapshot.payBasis === "monthly") {
      for (const line of lines.filter((item) => item.source === "salary_structure")) line.amountMinor = Math.round(line.amountMinor * monthlyAttendanceFactor);
      const unpaidLeaveUnits = attendanceDays.reduce((sum, day) => sum + (day.status === "leave" && day.isPaidLeave === false ? day.leaveUnits ?? 1 : 0), 0);
      const lopMinor = scheduledWorkDays > 0 ? Math.round(periodBaseRateMinor * unpaidLeaveUnits / scheduledWorkDays) : 0;
      if (lopMinor > 0) lines.push({ code: `LOP_${employee.id}`, name: `Unpaid leave · ${unpaidLeaveUnits} working day(s)`, kind: "deduction", amountMinor: lopMinor, source: "approved_unpaid_leave" });
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
    for (const earning of earnings) lines.push({ code: `DAILY_${earning.id}`, name: earning.description, kind: "earning", amountMinor: earning.amountMinor, source: `daily_${earning.source}`, sourceId: earning.id });
    for (const item of overtime) lines.push({ code: `OT_${item.id}`, name: "Approved overtime", kind: "earning", amountMinor: item.payableAmountMinor, source: "approved_overtime", sourceId: item.id });
    for (const leave of leaveRequests) {
      if (leave.startDate < period.periodStart || leave.endDate > period.periodEnd) throw new AppError("VALIDATION_ERROR", "An approved leave request crosses this payroll period boundary; split the request before previewing payroll", 422);
    }
    const total = (kind: "earning" | "deduction" | "employer_contribution") => lines.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.amountMinor, 0);
    const grossEarningsMinor = total("earning"); const deductionsMinor = total("deduction"); const employerContributionsMinor = total("employer_contribution");
    employeeRuns.push({ employeeId: employee.id, employeeNumber: employee.employeeNumber, employeeName: `${employee.firstName} ${employee.lastName}`.trim(), email: employee.email ?? "", phone: employee.phone ?? "", departmentName: departmentName ?? "", designationName: designationName ?? "", joiningDate: employee.joiningDate ?? "", currency, dailyRateMinor: snapshot.payBasis === "monthly" && scheduledWorkDays > 0 ? Math.round(periodBaseRateMinor / scheduledWorkDays) : null, scheduledWorkDays: snapshot.payBasis === "monthly" ? scheduledWorkDays : null, structureSnapshot: snapshot, attendanceDays, lines, grossEarningsMinor, deductionsMinor, employerContributionsMinor, netPayMinor: Math.max(0, grossEarningsMinor - deductionsMinor), paidMinor: 0, paymentReference: "" });
  }
  if (!employeeRuns.length) throw new AppError("VALIDATION_ERROR", "There are no active employees in this period", 422);
  const totals = { employees: employeeRuns.length, grossEarningsMinor: employeeRuns.reduce((sum, item) => sum + item.grossEarningsMinor, 0), deductionsMinor: employeeRuns.reduce((sum, item) => sum + item.deductionsMinor, 0), employerContributionsMinor: employeeRuns.reduce((sum, item) => sum + item.employerContributionsMinor, 0), netPayMinor: employeeRuns.reduce((sum, item) => sum + item.netPayMinor, 0) };
  const name = period.name?.trim() || `Payroll ${period.periodStart} – ${period.periodEnd}`;
  // Persisted lines carry `sourceId: null` when absent (the Mongoose subdocument default).
  const persistedEmployees: PayrollRunEmployee[] = employeeRuns.map((item) => ({ ...item, lines: item.lines.map((line): PayrollLine => ({ ...line, sourceId: line.sourceId ?? null })) }));
  const run = await db.transaction((tx) => insertPayrollRun(tx, { organizationId: orgId, name, periodKey, periodStart: period.periodStart, periodEnd: period.periodEnd, currency, state: "draft", totals, createdBy: actor.userId }, persistedEmployees));
  await recordAudit({ actor, action: "payroll.run_previewed", entityType: "payroll_run", entityId: run.id, organizationId: orgId, after: { name, periodKey, totals }, meta });
  return { id: run.id, name, periodKey, periodStart: period.periodStart, periodEnd: period.periodEnd, currency, state: run.state, totals, employees: employeeRuns };
}

export async function cancelPayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const [run] = await db.update(payrollRuns).set({ state: "cancelled", cancelledAt: new Date(), cancelledBy: actor.userId })
    .where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, "draft"), isNull(payrollRuns.revisionOf))).returning();
  if (!run) throw new AppError("INVALID_STATE", "Only an unsubmitted payroll preview can be cancelled", 409);
  await recordAudit({ actor, action: "payroll.run_cancelled", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: run.state, periodStart: run.periodStart, periodEnd: run.periodEnd }, meta });
  return { id, state: run.state };
}

export async function deletePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const [run] = await db.select().from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId))).limit(1);
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found", 404);
  const [hasPayments, hasPaidEmployees] = await Promise.all([
    rowExists(db.select({ id: payrollRunPayments.id }).from(payrollRunPayments).where(eq(payrollRunPayments.runId, run.id)).limit(1)),
    rowExists(db.select({ id: payrollRunEmployees.id }).from(payrollRunEmployees).where(and(eq(payrollRunEmployees.runId, run.id), gt(payrollRunEmployees.paidMinor, 0))).limit(1)),
  ]);
  if (hasPayments || hasPaidEmployees) throw new AppError("INVALID_STATE", "A payroll run with recorded employee payments cannot be deleted", 409);
  // Children are removed by ON DELETE CASCADE.
  await db.delete(payrollRuns).where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.organizationId, orgId)));
  await recordAudit({ actor, action: "payroll.run_deleted", entityType: "payroll_run", entityId: id, organizationId: orgId, before: { periodStart: run.periodStart, periodEnd: run.periodEnd, state: run.state }, meta });
  return { id, deleted: true };
}

export async function createPayrollRevision(actor: AuthContext, orgId: string, originalId: string, input: z.infer<typeof payrollRevisionSchema>, meta: RequestMeta) {
  const original = await loadPayrollRun(and(eq(payrollRuns.id, originalId), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, "finalized")));
  if (!original) throw new AppError("INVALID_STATE", "Only a finalized, unreversed payroll run can be revised", 409);
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  if (visibleEmployeeIds && original.employees.some((employee) => !visibleEmployeeIds.includes(employee.employeeId))) throw new AppError("NOT_FOUND", "Payroll run is outside your assigned workforce scope", 404);
  if (original.employees.some((employee) => employee.paidMinor !== 0) || original.payments.length > 0) throw new AppError("INVALID_STATE", "Paid payroll cannot be revised; create a separate adjustment or recovery record", 409);
  const activeRevision = await rowExists(db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.organizationId, orgId), eq(payrollRuns.revisionOf, original.id), inArray(payrollRuns.state, ["draft", "pending_approval", "approved", "finalized"]))).limit(1));
  if (activeRevision) throw new AppError("CONFLICT", "This payroll run already has an active revision", 409);
  const [latestRevision] = await db.select({ revision: payrollRuns.revision }).from(payrollRuns).where(and(eq(payrollRuns.organizationId, orgId), eq(payrollRuns.periodKey, original.periodKey))).orderBy(desc(payrollRuns.revision)).limit(1);
  const nextRevisionNumber = (latestRevision?.revision ?? original.revision) + 1;
  const byEmployee = new Map(original.employees.map((employee) => [employee.employeeId, employee]));
  const employees: PayrollRunEmployee[] = original.employees.map((source) => {
    const adjustment = input.adjustments.find((item) => item.employeeId === source.employeeId);
    if (!adjustment) return { ...source, paidMinor: 0, paymentReference: "" };
    const gross = source.grossEarningsMinor + adjustment.grossDeltaMinor;
    const deductions = source.deductionsMinor + adjustment.deductionsDeltaMinor;
    const contributions = source.employerContributionsMinor + adjustment.employerContributionsDeltaMinor;
    const net = gross - deductions;
    if (![gross, deductions, contributions, net].every(Number.isSafeInteger) || gross < 0 || deductions < 0 || contributions < 0 || net < 0) throw new AppError("VALIDATION_ERROR", `Revision amounts for ${source.employeeNumber} would create an invalid payroll total`, 422);
    const lines = [...source.lines];
    const suffix = `${nextRevisionNumber}_${source.employeeNumber}`;
    if (adjustment.grossDeltaMinor) lines.push({ code: `REV_GROSS_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "earning", amountMinor: adjustment.grossDeltaMinor, source: "payroll_revision", sourceId: null });
    if (adjustment.deductionsDeltaMinor) lines.push({ code: `REV_DEDUCTION_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "deduction", amountMinor: adjustment.deductionsDeltaMinor, source: "payroll_revision", sourceId: null });
    if (adjustment.employerContributionsDeltaMinor) lines.push({ code: `REV_CONTRIBUTION_${suffix}`, name: `Revision adjustment · ${input.reason}`, kind: "employer_contribution", amountMinor: adjustment.employerContributionsDeltaMinor, source: "payroll_revision", sourceId: null });
    return { ...source, lines, grossEarningsMinor: gross, deductionsMinor: deductions, employerContributionsMinor: contributions, netPayMinor: net, paidMinor: 0, paymentReference: "" };
  });
  for (const adjustment of input.adjustments) if (!byEmployee.has(adjustment.employeeId)) throw new AppError("NOT_FOUND", "A revision adjustment references an employee outside the original payroll run", 404);
  const totals = { employees: employees.length, grossEarningsMinor: employees.reduce((sum, item) => sum + item.grossEarningsMinor, 0), deductionsMinor: employees.reduce((sum, item) => sum + item.deductionsMinor, 0), employerContributionsMinor: employees.reduce((sum, item) => sum + item.employerContributionsMinor, 0), netPayMinor: employees.reduce((sum, item) => sum + item.netPayMinor, 0) };
  if (![totals.grossEarningsMinor, totals.deductionsMinor, totals.employerContributionsMinor, totals.netPayMinor].every(Number.isSafeInteger)) throw new AppError("VALIDATION_ERROR", "Revision totals exceed the safe currency range", 422);
  const revision = await db.transaction((tx) => insertPayrollRun(tx, { organizationId: orgId, name: original.name || "Payroll", periodKey: original.periodKey, periodStart: original.periodStart, periodEnd: original.periodEnd, currency: original.currency, state: "draft", totals, createdBy: actor.userId, revision: nextRevisionNumber, revisionOf: original.id, revisionReason: input.reason.trim() }, employees, []));
  await recordAudit({ actor, action: "payroll.revision_created", entityType: "payroll_run", entityId: revision.id, organizationId: orgId, before: { originalRunId: originalId, revision: original.revision, totals: original.totals }, after: { revision: revision.revision, reason: input.reason, totals }, meta });
  return { id: revision.id, revisionOf: originalId, revision: revision.revision, state: revision.state, periodStart: revision.periodStart, periodEnd: revision.periodEnd, totals, employees };
}

export async function cancelPayrollRevision(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const visibleEmployeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  // The scope check runs after the guarded update (as before), but inside the transaction so an out-of-scope cancel is rolled back.
  const revision = await db.transaction(async (tx) => {
    const [updated] = await tx.update(payrollRuns).set({ state: "cancelled", cancelledAt: new Date(), cancelledBy: actor.userId })
      .where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId), isNotNull(payrollRuns.revisionOf), inArray(payrollRuns.state, ["draft", "pending_approval"]))).returning();
    if (!updated) throw new AppError("INVALID_STATE", "Only an unfinalized payroll revision can be cancelled", 409);
    if (visibleEmployeeIds && updated.revisionOf) {
      const [original] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.id, updated.revisionOf), eq(payrollRuns.organizationId, orgId))).limit(1);
      const originalEmployees = original ? await tx.select({ employeeId: payrollRunEmployees.employeeId }).from(payrollRunEmployees).where(eq(payrollRunEmployees.runId, original.id)) : [];
      if (!original || originalEmployees.some((employee) => !visibleEmployeeIds.includes(employee.employeeId))) throw new AppError("NOT_FOUND", "Payroll revision is outside your assigned workforce scope", 404);
    }
    return updated;
  });
  await recordAudit({ actor, action: "payroll.revision_cancelled", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: revision.state, revisionOf: revision.revisionOf ?? undefined, reason: revision.revisionReason }, meta });
  return { id, state: revision.state };
}

type PayrollState = "draft" | "pending_approval" | "approved" | "finalized";
async function transitionPayrollRun(actor: AuthContext, orgId: string, id: string, from: PayrollState, to: PayrollState, action: string, meta: RequestMeta) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  await assertPayrollRunWithinScope(orgId, id, employeeIds, "Payroll run is outside your assigned workforce scope");
  const update: Partial<typeof payrollRuns.$inferInsert> = { state: to };
  if (to === "approved") { update.approvedBy = actor.userId; update.approvedAt = new Date(); }
  if (to === "finalized") { update.finalizedBy = actor.userId; update.finalizedAt = new Date(); }
  const [run] = await db.update(payrollRuns).set(update).where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, from))).returning({ totals: payrollRuns.totals });
  if (!run) throw new AppError("CONFLICT", `Payroll run cannot transition from ${from} to ${to}`, 409);
  await recordAudit({ actor, action, entityType: "payroll_run", entityId: id, organizationId: orgId, after: { state: to }, meta });
  return { id, state: to, totals: run.totals };
}

export async function submitPayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) { return transitionPayrollRun(actor, orgId, id, "draft", "pending_approval", "payroll.run_submitted", meta); }
export async function approvePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) { return transitionPayrollRun(actor, orgId, id, "pending_approval", "approved", "payroll.run_approved", meta); }
export async function finalizePayrollRun(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  await assertPayrollRunWithinScope(orgId, id, employeeIds, "Payroll run is outside your assigned workforce scope");
  const [revision] = await db.select({ id: payrollRuns.id, revisionOf: payrollRuns.revisionOf }).from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, "approved"), isNotNull(payrollRuns.revisionOf))).limit(1);
  if (revision?.revisionOf) {
    const revisionOf = revision.revisionOf;
    // Reverse the original only while it is finalized and fully unpaid; the row lock serializes with payment recording.
    const original = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.id, revisionOf), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, "finalized"))).for("update");
      if (!locked) return null;
      const [paid] = await tx.select({ total: sql<number>`coalesce(sum(${payrollRunEmployees.paidMinor}), 0)`.mapWith(Number) }).from(payrollRunEmployees).where(eq(payrollRunEmployees.runId, locked.id));
      if ((paid?.total ?? 0) !== 0) return null;
      const [reversed] = await tx.update(payrollRuns).set({ state: "reversed", reversedBy: revision.id, reversedAt: new Date() }).where(eq(payrollRuns.id, locked.id)).returning({ id: payrollRuns.id });
      return reversed ?? null;
    });
    if (!original) {
      const recoverable = await rowExists(db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.id, revisionOf), eq(payrollRuns.organizationId, orgId), eq(payrollRuns.state, "reversed"), eq(payrollRuns.reversedBy, revision.id))).limit(1));
      if (!recoverable) throw new AppError("CONFLICT", "The original run was paid or changed; this revision cannot replace it", 409);
    } else {
      await recordAudit({ actor, action: "payroll.run_reversed", entityType: "payroll_run", entityId: original.id, organizationId: orgId, before: { state: "finalized" }, after: { state: "reversed", replacedBy: revision.id }, meta });
    }
  }
  return transitionPayrollRun(actor, orgId, id, "approved", "finalized", "payroll.run_finalized", meta);
}

export async function recordPayrollPayment(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof payrollPaymentSchema>, meta: RequestMeta) {
  await assertWorkforceEmployeeAccessible(orgId, actor, input.employeeId);
  const payment = { employeeId: input.employeeId, amountMinor: input.amountMinor, reference: (input.reference ?? "").trim(), recordedBy: actor.userId, recordedAt: new Date() };
  const conflict = () => new AppError("CONFLICT", "Payroll must be finalized and payment cannot exceed the remaining employee balance", 409);
  const state = await db.transaction(async (tx) => {
    // Lock the run so concurrent payments / reversals are serialized.
    const [run] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.organizationId, orgId), inArray(payrollRuns.state, ["finalized", "partially_paid"]))).for("update");
    if (!run) throw conflict();
    const eligible = await tx.select({ id: payrollRunEmployees.id }).from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.employeeId, input.employeeId), lte(payrollRunEmployees.paidMinor, sql`${payrollRunEmployees.netPayMinor} - ${input.amountMinor}`))).limit(1);
    if (!eligible.length) throw conflict();
    await tx.update(payrollRunEmployees).set({ paidMinor: sql`${payrollRunEmployees.paidMinor} + ${input.amountMinor}` }).where(and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.employeeId, input.employeeId)));
    const [next] = await tx.select({ position: sql<number>`coalesce(max(${payrollRunPayments.position}), -1) + 1`.mapWith(Number) }).from(payrollRunPayments).where(eq(payrollRunPayments.runId, run.id));
    await tx.insert(payrollRunPayments).values({ ...payment, runId: run.id, organizationId: orgId, position: next?.position ?? 0 });
    const [sums] = await tx.select({
      paid: sql<number>`coalesce(sum(${payrollRunEmployees.paidMinor}), 0)`.mapWith(Number),
      net: sql<number>`coalesce(sum(${payrollRunEmployees.netPayMinor}), 0)`.mapWith(Number),
    }).from(payrollRunEmployees).where(eq(payrollRunEmployees.runId, run.id));
    const nextState = sums!.paid === sums!.net ? "paid" as const : "partially_paid" as const;
    await tx.update(payrollRuns).set({ state: nextState }).where(eq(payrollRuns.id, run.id));
    return nextState;
  });
  await recordAudit({ actor, action: "payroll.payment_recorded", entityType: "payroll_run", entityId: id, organizationId: orgId, after: { employeeId: input.employeeId, amountMinor: input.amountMinor, reference: payment.reference }, meta });
  return { id, employeeId: input.employeeId, amountMinor: input.amountMinor, state };
}
