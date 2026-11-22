import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { WorkforceEmployeeModel } from "./employee.model.js";
import { LeaveBalanceModel, LeaveRequestModel, LeaveTypeModel } from "./leave.model.js";
import { accessibleWorkforceEmployeeIds, assertWorkforceEmployeeAccessible } from "./data-scope.js";
import type { leaveRequestSchema, leaveReviewSchema, leaveTypeSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;
type LeaveInput = z.infer<typeof leaveRequestSchema>;

export async function listLeaveTypes(orgId: string, includeBalances = true) {
  if (!includeBalances) return { types: await LeaveTypeModel.find({ organizationId: orgId, status: "active" }).select("code name paid annualEntitlementDays status").sort({ name: 1 }).lean(), balances: [] };
  const [types, balances] = await Promise.all([LeaveTypeModel.find({ organizationId: orgId }).sort({ name: 1 }).lean(), LeaveBalanceModel.find({ organizationId: orgId }).populate("employeeId", "employeeNumber firstName lastName").populate("leaveTypeId", "code name paid").sort({ year: -1 }).lean()]);
  return { types: types.map((item) => ({ id: item._id.toString(), code: item.code, name: item.name, paid: item.paid, annualEntitlementDays: item.annualEntitlementDays, status: item.status })), balances: balances.map((item: any) => ({ id: item._id.toString(), employee: item.employeeId, leaveType: item.leaveTypeId, year: item.year, entitlementDays: item.entitlementDays, usedDays: item.usedDays, availableDays: Math.max(0, item.entitlementDays - item.usedDays) })) };
}

export async function createLeaveType(actor: AuthContext, orgId: string, input: LeaveTypeInput, meta: RequestMeta) {
  const item = await LeaveTypeModel.create({ ...input, organizationId: orgId });
  await recordAudit({ actor, action: "leave.type_created", entityType: "leave_type", entityId: item._id.toString(), organizationId: orgId, after: input, meta });
  return { id: item._id.toString(), ...input };
}

export async function updateLeaveType(actor: AuthContext, orgId: string, id: string, input: LeaveTypeInput, meta: RequestMeta) {
  const item = await LeaveTypeModel.findOneAndUpdate({ _id: id, organizationId: orgId }, { $set: input }, { new: true, runValidators: true });
  if (!item) throw new AppError("NOT_FOUND", "Leave type not found", 404);
  await recordAudit({ actor, action: "leave.type_updated", entityType: "leave_type", entityId: id, organizationId: orgId, after: input, meta });
  return { id, ...input };
}

export async function deleteLeaveType(actor: AuthContext, orgId: string, id: string, meta: RequestMeta) {
  const item = await LeaveTypeModel.findOne({ _id: id, organizationId: orgId });
  if (!item) throw new AppError("NOT_FOUND", "Leave type not found", 404);
  const [requests, balances] = await Promise.all([
    LeaveRequestModel.exists({ organizationId: orgId, leaveTypeId: id }),
    LeaveBalanceModel.exists({ organizationId: orgId, leaveTypeId: id }),
  ]);
  if (requests || balances) throw new AppError("CONFLICT", "This leave type has employee requests or balance history. Edit it or set it inactive instead.", 409);
  await LeaveTypeModel.deleteOne({ _id: id, organizationId: orgId });
  await recordAudit({ actor, action: "leave.type_deleted", entityType: "leave_type", entityId: id, organizationId: orgId, before: { code: item.code, name: item.name }, meta });
  return { id, deleted: true };
}

export async function requestLeave(actor: AuthContext, orgId: string, input: LeaveInput, meta: RequestMeta) {
  const employee = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId, status: "active" });
  if (!employee) throw new AppError("NOT_FOUND", "An active employee profile linked to your account is required", 404);
  const start = Date.parse(`${input.startDate}T00:00:00Z`); const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const maxDays = Math.floor((end - start) / 86400000) + 1;
  if (input.days > maxDays) throw new AppError("VALIDATION_ERROR", "Requested leave days exceed the selected calendar date range", 422);
  const year = Number(input.startDate.slice(0, 4));
  if (Number(input.endDate.slice(0, 4)) !== year) throw new AppError("VALIDATION_ERROR", "Submit separate requests for leave spanning calendar years", 422);
  const leaveType = await LeaveTypeModel.findOne({ _id: input.leaveTypeId, organizationId: orgId, status: "active" });
  if (!leaveType) throw new AppError("NOT_FOUND", "Active leave type not found", 404);
  const overlap = await LeaveRequestModel.exists({ organizationId: orgId, employeeId: employee._id, startDate: { $lte: input.endDate }, endDate: { $gte: input.startDate }, status: { $in: ["pending", "approved"] } });
  if (overlap) throw new AppError("CONFLICT", "This request overlaps an existing pending or approved leave request", 409);
  let balance: any = await LeaveBalanceModel.findOneAndUpdate({ organizationId: orgId, employeeId: employee._id, leaveTypeId: leaveType._id, year }, { $setOnInsert: { organizationId: orgId, employeeId: employee._id, leaveTypeId: leaveType._id, year, entitlementDays: leaveType.annualEntitlementDays, usedDays: 0 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const pending = await LeaveRequestModel.aggregate([{ $match: { organizationId: new Types.ObjectId(orgId), employeeId: employee._id, leaveTypeId: leaveType._id, status: "pending", startDate: { $regex: `^${year}` } } }, { $group: { _id: null, days: { $sum: "$days" } } }]);
  const requestedOutstanding = pending[0]?.days ?? 0;
  if (leaveType.paid && balance.entitlementDays - balance.usedDays - requestedOutstanding < input.days) throw new AppError("VALIDATION_ERROR", "This request exceeds the available leave balance", 422);
  const request = await LeaveRequestModel.create({ ...input, organizationId: orgId, employeeId: employee._id, status: "pending" });
  await recordAudit({ actor, action: "leave.requested", entityType: "leave_request", entityId: request._id.toString(), organizationId: orgId, after: input, meta });
  return { id: request._id.toString(), startDate: request.startDate, endDate: request.endDate, days: request.days, status: request.status, leaveType: { id: leaveType._id.toString(), name: leaveType.name, paid: leaveType.paid } };
}

export async function listLeaveRequests(orgId: string, employeeId?: string, actor?: AuthContext) {
  const visibleEmployeeIds = actor ? await accessibleWorkforceEmployeeIds(orgId, actor) : null;
  const requests = await LeaveRequestModel.find({ organizationId: orgId, ...(visibleEmployeeIds ? { employeeId: { $in: visibleEmployeeIds } } : {}), ...(employeeId ? { employeeId } : {}) }).populate("employeeId", "employeeNumber firstName lastName").populate("leaveTypeId", "code name paid").sort({ startDate: -1, createdAt: -1 }).limit(500).lean();
  return requests.map((item: any) => ({ id: item._id.toString(), employee: item.employeeId, leaveType: item.leaveTypeId, startDate: item.startDate, endDate: item.endDate, days: item.days, reason: item.reason, status: item.status, reviewedBy: item.reviewedBy?.toString() ?? null, reviewedAt: item.reviewedAt, reviewComment: item.reviewComment, createdAt: item.createdAt }));
}

export async function listOwnLeaveRequests(actor: AuthContext, orgId: string) {
  const employee = await WorkforceEmployeeModel.findOne({ organizationId: orgId, userId: actor.userId }).select("_id");
  return employee ? listLeaveRequests(orgId, employee._id.toString()) : [];
}

export async function reviewLeave(actor: AuthContext, orgId: string, id: string, input: z.infer<typeof leaveReviewSchema>, meta: RequestMeta) {
  const request = await LeaveRequestModel.findOne({ _id: id, organizationId: orgId, status: "pending" });
  if (!request) throw new AppError("NOT_FOUND", "Pending leave request not found", 404);
  await assertWorkforceEmployeeAccessible(orgId, actor, request.employeeId.toString());
  request.status = input.decision; request.reviewedBy = new Types.ObjectId(actor.userId); request.reviewedAt = new Date(); request.reviewComment = input.comment ?? "";
  await request.save();
  if (input.decision === "approved") {
    const year = Number(request.startDate.slice(0, 4));
    const leaveType = await LeaveTypeModel.findOne({ _id: request.leaveTypeId, organizationId: orgId });
    if (leaveType?.paid) {
      const balance = await LeaveBalanceModel.findOneAndUpdate({ organizationId: orgId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year, $expr: { $gte: [{ $subtract: ["$entitlementDays", "$usedDays"] }, request.days] } }, { $inc: { usedDays: request.days } }, { new: true });
      if (!balance) { await LeaveRequestModel.updateOne({ _id: id, organizationId: orgId, status: "approved" }, { $set: { status: "pending", reviewedBy: null, reviewedAt: null, reviewComment: "" } }); throw new AppError("CONFLICT", "Leave balance changed before approval; request remains pending", 409); }
    }
  }
  await recordAudit({ actor, action: `leave.request_${input.decision}`, entityType: "leave_request", entityId: id, organizationId: orgId, after: { status: input.decision, comment: input.comment ?? "" }, meta });
  return { id, status: request.status, reviewComment: request.reviewComment };
}
