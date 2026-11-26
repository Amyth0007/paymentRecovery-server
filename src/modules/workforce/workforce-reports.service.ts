import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { db } from "../../database/connection.js";
import {
  attendanceAdjustments,
  attendanceRecords,
  leaveRequests,
  overtimeEntries,
  payrollRunEmployees,
  payrollRuns,
  workforceEmployees,
} from "../../database/schema.js";
import { accessibleWorkforceEmployeeIds } from "./data-scope.js";

const sumNumber = (value: SQL | unknown) => sql<number>`coalesce(sum(${value}), 0)`.mapWith(Number);
const countNumber = () => sql<number>`count(*)`.mapWith(Number);
const countWhere = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/** `inArray` that matches nothing for an empty list (Mongo `$in: []` semantics). */
function inIds(column: Parameters<typeof inArray>[0], ids: string[]): SQL {
  return ids.length ? inArray(column, ids) : sql`false`;
}

export async function attendanceReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const profileIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const profiles = profileIds
    ? (profileIds.length ? await db.select({ userId: workforceEmployees.userId }).from(workforceEmployees).where(and(eq(workforceEmployees.organizationId, orgId), inArray(workforceEmployees.id, profileIds))) : [])
    : null;
  const userIds = profiles ? profiles.map((profile) => profile.userId).filter((id): id is string => Boolean(id)) : null;
  const [records, adjustments, leave] = await Promise.all([
    db.select({
      totalRecords: countNumber(),
      completed: countWhere(eq(attendanceRecords.status, "completed")),
      currentlyCheckedIn: countWhere(eq(attendanceRecords.status, "checked_in")),
      lateArrivals: countWhere(eq(attendanceRecords.lateArrival, true)),
      totalWorkingMinutes: sumNumber(attendanceRecords.totalWorkingMinutes),
    }).from(attendanceRecords).where(and(
      eq(attendanceRecords.organizationId, orgId),
      userIds ? inIds(attendanceRecords.employeeId, userIds) : undefined,
      gte(attendanceRecords.attendanceDate, from),
      lte(attendanceRecords.attendanceDate, to),
    )),
    db.select({ status: attendanceAdjustments.status, count: countNumber() }).from(attendanceAdjustments).where(and(
      eq(attendanceAdjustments.organizationId, orgId),
      userIds ? inIds(attendanceAdjustments.employeeId, userIds) : undefined,
      gte(attendanceAdjustments.attendanceDate, from),
      lte(attendanceAdjustments.attendanceDate, to),
    )).groupBy(attendanceAdjustments.status),
    db.select({ approvedRequests: countNumber(), approvedDays: sumNumber(leaveRequests.days) }).from(leaveRequests).where(and(
      eq(leaveRequests.organizationId, orgId),
      profileIds ? inIds(leaveRequests.employeeId, profileIds) : undefined,
      eq(leaveRequests.status, "approved"),
      lte(leaveRequests.startDate, to),
      gte(leaveRequests.endDate, from),
    )),
  ]);
  // A Mongo `$group: { _id: null }` produced no row when nothing matched, and `{ _id: null, ... }` otherwise.
  const attendance = records[0] && records[0].totalRecords > 0 ? { _id: null, ...records[0] } : { totalRecords: 0, completed: 0, currentlyCheckedIn: 0, lateArrivals: 0, totalWorkingMinutes: 0 };
  const approvedLeave = leave[0] && leave[0].approvedRequests > 0 ? { _id: null, ...leave[0] } : { approvedRequests: 0, approvedDays: 0 };
  return { from, to, attendance, adjustments: Object.fromEntries(adjustments.map((item) => [item.status, item.count])), approvedLeave };
}

export async function payrollReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const runs = await db.select({ id: payrollRuns.id, periodKey: payrollRuns.periodKey, periodStart: payrollRuns.periodStart, periodEnd: payrollRuns.periodEnd, currency: payrollRuns.currency })
    .from(payrollRuns)
    .where(and(
      eq(payrollRuns.organizationId, orgId),
      inArray(payrollRuns.state, ["finalized", "partially_paid", "paid"]),
      employeeIds
        ? (employeeIds.length
          ? sql`exists (select 1 from ${payrollRunEmployees} where ${payrollRunEmployees.runId} = ${payrollRuns.id} and ${inArray(payrollRunEmployees.employeeId, employeeIds)})`
          : sql`false`)
        : undefined,
      gte(payrollRuns.periodStart, from),
      lte(payrollRuns.periodEnd, to),
    ))
    .orderBy(asc(payrollRuns.periodStart));
  const runIds = runs.map((run) => run.id);
  const employeeRows = runIds.length
    ? await db.select({
      runId: payrollRunEmployees.runId,
      employeeId: payrollRunEmployees.employeeId,
      employeeNumber: payrollRunEmployees.employeeNumber,
      employeeName: payrollRunEmployees.employeeName,
      grossEarningsMinor: payrollRunEmployees.grossEarningsMinor,
      deductionsMinor: payrollRunEmployees.deductionsMinor,
      employerContributionsMinor: payrollRunEmployees.employerContributionsMinor,
      netPayMinor: payrollRunEmployees.netPayMinor,
      paidMinor: payrollRunEmployees.paidMinor,
    }).from(payrollRunEmployees).where(inArray(payrollRunEmployees.runId, runIds)).orderBy(asc(payrollRunEmployees.runId), asc(payrollRunEmployees.position))
    : [];
  const employeesByRun = new Map<string, typeof employeeRows>();
  for (const row of employeeRows) {
    const list = employeesByRun.get(row.runId) ?? [];
    list.push(row);
    employeesByRun.set(row.runId, list);
  }
  const visible = employeeIds ? new Set(employeeIds) : null;
  return runs.map((run) => {
    const runEmployees = employeesByRun.get(run.id) ?? [];
    const employees = visible ? runEmployees.filter((employee) => visible.has(employee.employeeId)) : runEmployees;
    const totals = { employees: employees.length, grossEarningsMinor: employees.reduce((sum, employee) => sum + employee.grossEarningsMinor, 0), deductionsMinor: employees.reduce((sum, employee) => sum + employee.deductionsMinor, 0), employerContributionsMinor: employees.reduce((sum, employee) => sum + employee.employerContributionsMinor, 0), netPayMinor: employees.reduce((sum, employee) => sum + employee.netPayMinor, 0) };
    return { periodKey: run.periodKey, periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, totals, unpaidMinor: Math.max(0, employees.reduce((sum, employee) => sum + employee.netPayMinor - employee.paidMinor, 0)), employees: employees.map((employee) => ({ employeeNumber: employee.employeeNumber, employeeName: employee.employeeName, netPayMinor: employee.netPayMinor, paidMinor: employee.paidMinor })) };
  });
}

export async function overtimeReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const result = await db.select({
    _id: overtimeEntries.status,
    entries: countNumber(),
    actualMinutes: sumNumber(overtimeEntries.actualMinutes),
    calculatedMinutes: sumNumber(overtimeEntries.calculatedMinutes),
    approvedMinutes: sumNumber(overtimeEntries.approvedMinutes),
    payableAmountMinor: sumNumber(overtimeEntries.payableAmountMinor),
  }).from(overtimeEntries).where(and(
    eq(overtimeEntries.organizationId, orgId),
    employeeIds ? inIds(overtimeEntries.employeeId, employeeIds) : undefined,
    gte(overtimeEntries.workDate, from),
    lte(overtimeEntries.workDate, to),
  )).groupBy(overtimeEntries.status).orderBy(asc(overtimeEntries.status));
  return { from, to, byStatus: result };
}

export async function leaveReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const result = await db.select({
    _id: leaveRequests.status,
    requests: countNumber(),
    days: sumNumber(leaveRequests.days),
  }).from(leaveRequests).where(and(
    eq(leaveRequests.organizationId, orgId),
    employeeIds ? inIds(leaveRequests.employeeId, employeeIds) : undefined,
    lte(leaveRequests.startDate, to),
    gte(leaveRequests.endDate, from),
  )).groupBy(leaveRequests.status).orderBy(asc(leaveRequests.status));
  return { from, to, byStatus: result };
}
