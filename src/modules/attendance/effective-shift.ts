import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { shiftAssignments, shifts, shiftSwaps } from "../../database/schema.js";

export type EffectiveShift = typeof shifts.$inferSelect;

async function loadShift(organizationId: string, shiftId: string | null): Promise<EffectiveShift | null> {
  if (!shiftId) return null;
  const rows = await db.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.organizationId, organizationId))).limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the shift row (with `id`, no `_id`) effective for a workforce employee on a date, or null.
 */
export async function getEffectiveShiftForDate(
  organizationId: string,
  employeeProfileId: string,
  date: string,
): Promise<EffectiveShift | null> {
  // 1. Check for an approved swap on this date
  const [swap] = await db.select().from(shiftSwaps).where(and(
    eq(shiftSwaps.organizationId, organizationId),
    eq(shiftSwaps.shiftDate, date),
    eq(shiftSwaps.status, "approved"),
    or(eq(shiftSwaps.requesterEmployeeId, employeeProfileId), eq(shiftSwaps.targetEmployeeId, employeeProfileId)),
  )).limit(1);

  if (swap) {
    if (swap.requesterEmployeeId === employeeProfileId) {
      const shift = await loadShift(organizationId, swap.targetShiftId);
      if (shift) return shift;
    } else if (swap.targetEmployeeId === employeeProfileId) {
      const shift = await loadShift(organizationId, swap.requesterShiftId);
      if (shift) return shift;
    }
  }

  // 2. Regular shift assignment
  const [assignment] = await db.select({ shift: shifts }).from(shiftAssignments)
    .leftJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(
      eq(shiftAssignments.organizationId, organizationId),
      eq(shiftAssignments.employeeId, employeeProfileId),
      lte(shiftAssignments.effectiveFrom, date),
      or(isNull(shiftAssignments.effectiveTo), gte(shiftAssignments.effectiveTo, date)),
    ))
    .orderBy(desc(shiftAssignments.effectiveFrom))
    .limit(1);

  return assignment?.shift ?? null;
}
