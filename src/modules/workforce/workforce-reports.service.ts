import { Types } from "mongoose";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AttendanceAdjustmentModel } from "../attendance/attendance-adjustment.model.js";
import { AttendanceRecordModel } from "../attendance/attendance-record.model.js";
import { PayrollRunModel } from "./payroll-run.model.js";
import { OvertimeEntryModel } from "./overtime.model.js";
import { LeaveRequestModel } from "./leave.model.js";
import { accessibleWorkforceEmployeeIds } from "./data-scope.js";
import { WorkforceEmployeeModel } from "./employee.model.js";

export async function attendanceReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const organizationId = new Types.ObjectId(orgId);
  const profileIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const profiles = profileIds ? await WorkforceEmployeeModel.find({ organizationId, _id: { $in: profileIds } }).select("userId").lean() : null;
  const userIds = profiles ? profiles.map((profile) => profile.userId).filter(Boolean) : null;
  const employeeRecordMatch = userIds ? { employeeId: { $in: userIds } } : {};
  const employeeProfileMatch = profileIds ? { employeeId: { $in: profileIds } } : {};
  const [records, adjustments, leaveRequests] = await Promise.all([
    AttendanceRecordModel.aggregate([{ $match: { organizationId, ...employeeRecordMatch, attendanceDate: { $gte: from, $lte: to } } }, { $group: { _id: null, totalRecords: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } }, currentlyCheckedIn: { $sum: { $cond: [{ $eq: ["$status", "checked_in"] }, 1, 0] } }, lateArrivals: { $sum: { $cond: ["$lateArrival", 1, 0] } }, totalWorkingMinutes: { $sum: { $ifNull: ["$totalWorkingMinutes", 0] } } } }]),
    AttendanceAdjustmentModel.aggregate([{ $match: { organizationId, ...employeeRecordMatch, attendanceDate: { $gte: from, $lte: to } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    LeaveRequestModel.aggregate([{ $match: { organizationId, ...employeeProfileMatch, status: "approved", startDate: { $lte: to }, endDate: { $gte: from } } }, { $group: { _id: null, approvedRequests: { $sum: 1 }, approvedDays: { $sum: "$days" } } }]),
  ]);
  return { from, to, attendance: records[0] ?? { totalRecords: 0, completed: 0, currentlyCheckedIn: 0, lateArrivals: 0, totalWorkingMinutes: 0 }, adjustments: Object.fromEntries(adjustments.map((item) => [item._id, item.count])), approvedLeave: leaveRequests[0] ?? { approvedRequests: 0, approvedDays: 0 } };
}

export async function payrollReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const runs = await PayrollRunModel.find({ organizationId: orgId, state: { $in: ["finalized", "partially_paid", "paid"] }, ...(employeeIds ? { "employees.employeeId": { $in: employeeIds } } : {}), periodStart: { $gte: from }, periodEnd: { $lte: to } }).select("periodKey periodStart periodEnd currency employees.employeeId employees.employeeNumber employees.employeeName employees.grossEarningsMinor employees.deductionsMinor employees.employerContributionsMinor employees.netPayMinor employees.paidMinor").sort({ periodStart: 1 }).lean();
  return runs.map((run) => {
    const employees = employeeIds ? run.employees.filter((employee) => employeeIds.some((id) => id.toString() === employee.employeeId.toString())) : run.employees;
    const totals = { employees: employees.length, grossEarningsMinor: employees.reduce((sum, employee) => sum + employee.grossEarningsMinor, 0), deductionsMinor: employees.reduce((sum, employee) => sum + employee.deductionsMinor, 0), employerContributionsMinor: employees.reduce((sum, employee) => sum + employee.employerContributionsMinor, 0), netPayMinor: employees.reduce((sum, employee) => sum + employee.netPayMinor, 0) };
    return { periodKey: run.periodKey, periodStart: run.periodStart, periodEnd: run.periodEnd, currency: run.currency, totals, unpaidMinor: Math.max(0, employees.reduce((sum, employee) => sum + employee.netPayMinor - employee.paidMinor, 0)), employees: employees.map((employee) => ({ employeeNumber: employee.employeeNumber, employeeName: employee.employeeName, netPayMinor: employee.netPayMinor, paidMinor: employee.paidMinor })) };
  });
}

export async function overtimeReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const result = await OvertimeEntryModel.aggregate([{ $match: { organizationId: new Types.ObjectId(orgId), ...(employeeIds ? { employeeId: { $in: employeeIds } } : {}), workDate: { $gte: from, $lte: to } } }, { $group: { _id: "$status", entries: { $sum: 1 }, actualMinutes: { $sum: "$actualMinutes" }, calculatedMinutes: { $sum: "$calculatedMinutes" }, approvedMinutes: { $sum: "$approvedMinutes" }, payableAmountMinor: { $sum: "$payableAmountMinor" } } }, { $sort: { _id: 1 } }]);
  return { from, to, byStatus: result };
}

export async function leaveReport(actor: AuthContext, orgId: string, from: string, to: string) {
  const employeeIds = await accessibleWorkforceEmployeeIds(orgId, actor);
  const result = await LeaveRequestModel.aggregate([{ $match: { organizationId: new Types.ObjectId(orgId), ...(employeeIds ? { employeeId: { $in: employeeIds } } : {}), startDate: { $lte: to }, endDate: { $gte: from } } }, { $group: { _id: "$status", requests: { $sum: 1 }, days: { $sum: "$days" } } }, { $sort: { _id: 1 } }]);
  return { from, to, byStatus: result };
}
