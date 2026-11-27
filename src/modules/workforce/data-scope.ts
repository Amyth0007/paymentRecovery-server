import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { usesActionPermissions, type AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { db } from "../../database/connection.js";
import { workforceEmployees } from "../../database/schema.js";

/** True when the actor uses action-level permissions (subadmin or configured team member) with a "selected" workforce scope (i.e. not organization-wide). */
export function isWorkforceScopeRestricted(actor: AuthContext): boolean {
  const scope = actor.workforceScope;
  return usesActionPermissions(actor) && Boolean(scope) && scope!.mode !== "organization";
}

/**
 * A selected workforce scope is the intersection of every populated dimension.
 * Empty dimensions are unrestricted; a selected scope with no dimensions is denied.
 *
 * Returns a condition on `workforceEmployees` to AND into a query, or `undefined` when the actor
 * has organization-wide access (no restriction). A restricted scope with no dimensions yields `false`.
 */
export function workforceEmployeeScopeCondition(actor: AuthContext): SQL | undefined {
  if (!isWorkforceScopeRestricted(actor)) return undefined;
  const scope = actor.workforceScope!;
  const clauses: SQL[] = [];
  if (scope.departmentIds.length) clauses.push(inArray(workforceEmployees.departmentId, scope.departmentIds));
  if (scope.locationIds.length) clauses.push(inArray(workforceEmployees.workLocationId, scope.locationIds));
  return clauses.length ? and(...clauses)! : sql`false`;
}

export async function accessibleWorkforceEmployeeIds(organizationId: string, actor: AuthContext): Promise<string[] | null> {
  const condition = workforceEmployeeScopeCondition(actor);
  if (!condition) return null;
  const employees = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.organizationId, organizationId), condition));
  return employees.map((employee) => employee.id);
}

export async function assertWorkforceEmployeeAccessible(organizationId: string, actor: AuthContext, employeeId: string) {
  const condition = workforceEmployeeScopeCondition(actor);
  if (!condition) return;
  const rows = await db.select({ id: workforceEmployees.id }).from(workforceEmployees)
    .where(and(eq(workforceEmployees.id, employeeId), eq(workforceEmployees.organizationId, organizationId), condition)).limit(1);
  if (!rows.length) throw new AppError("NOT_FOUND", "Employee was not found in your assigned workforce scope", 404);
}

export function assertWorkforceAssignmentWithinScope(actor: AuthContext, departmentId?: string | null, locationId?: string | null) {
  const scope = actor.workforceScope;
  if (!usesActionPermissions(actor) || !scope || scope.mode === "organization") return;
  if (scope.departmentIds.length && (!departmentId || !scope.departmentIds.includes(departmentId))) throw new AppError("FORBIDDEN", "The employee must belong to one of your assigned departments", 403);
  if (scope.locationIds.length && (!locationId || !scope.locationIds.includes(locationId))) throw new AppError("FORBIDDEN", "The employee must belong to one of your assigned work locations", 403);
  if (!scope.departmentIds.length && !scope.locationIds.length) throw new AppError("FORBIDDEN", "No workforce scope is assigned to your account", 403);
}
