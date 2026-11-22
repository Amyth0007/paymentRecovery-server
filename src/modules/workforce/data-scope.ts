import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { Types } from "mongoose";
import { WorkforceEmployeeModel } from "./employee.model.js";

/**
 * A selected workforce scope is the intersection of every populated dimension.
 * Empty dimensions are unrestricted; a selected scope with no dimensions is denied.
 */
export function workforceEmployeeScopeFilter(actor: AuthContext): Record<string, unknown> {
  const scope = actor.workforceScope;
  if (actor.role !== "sub_admin" || !scope || scope.mode === "organization") return {};
  const clauses: Record<string, unknown>[] = [];
  if (scope.departmentIds.length) clauses.push({ departmentId: { $in: scope.departmentIds.map((id) => new Types.ObjectId(id)) } });
  if (scope.locationIds.length) clauses.push({ workLocationId: { $in: scope.locationIds.map((id) => new Types.ObjectId(id)) } });
  return clauses.length ? { $and: clauses } : { _id: { $exists: false } };
}

export async function accessibleWorkforceEmployeeIds(organizationId: string, actor: AuthContext): Promise<Types.ObjectId[] | null> {
  const filter = workforceEmployeeScopeFilter(actor);
  if (!Object.keys(filter).length) return null;
  const employees = await WorkforceEmployeeModel.find({ organizationId, ...filter }).select("_id").lean();
  return employees.map((employee) => employee._id as Types.ObjectId);
}

export async function assertWorkforceEmployeeAccessible(organizationId: string, actor: AuthContext, employeeId: string) {
  const filter = workforceEmployeeScopeFilter(actor);
  if (!Object.keys(filter).length) return;
  const exists = await WorkforceEmployeeModel.exists({ _id: employeeId, organizationId, ...filter });
  if (!exists) throw new AppError("NOT_FOUND", "Employee was not found in your assigned workforce scope", 404);
}

export function assertWorkforceAssignmentWithinScope(actor: AuthContext, departmentId?: string | null, locationId?: string | null) {
  const scope = actor.workforceScope;
  if (actor.role !== "sub_admin" || !scope || scope.mode === "organization") return;
  if (scope.departmentIds.length && (!departmentId || !scope.departmentIds.includes(departmentId))) throw new AppError("FORBIDDEN", "The employee must belong to one of your assigned departments", 403);
  if (scope.locationIds.length && (!locationId || !scope.locationIds.includes(locationId))) throw new AppError("FORBIDDEN", "The employee must belong to one of your assigned work locations", 403);
  if (!scope.departmentIds.length && !scope.locationIds.length) throw new AppError("FORBIDDEN", "This subadmin has no assigned workforce scope", 403);
}
