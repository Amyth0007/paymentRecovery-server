import type { Types } from "mongoose";
import { ShiftAssignmentModel } from "../workforce/shift-assignment.model.js";
import { ShiftSwapModel } from "../workforce/shift-swap.model.js";

export async function getEffectiveShiftForDate(
  organizationId: string | Types.ObjectId,
  employeeProfileId: string | Types.ObjectId,
  date: string,
) {
  // 1. Check for an approved swap on this date
  const swap: any = await ShiftSwapModel.findOne({
    organizationId,
    shiftDate: date,
    status: "approved",
    $or: [
      { requesterEmployeeId: employeeProfileId },
      { targetEmployeeId: employeeProfileId },
    ],
  })
    .populate("requesterShiftId")
    .populate("targetShiftId");

  if (swap) {
    if (swap.requesterEmployeeId.toString() === employeeProfileId.toString()) {
      if (swap.targetShiftId) return swap.targetShiftId;
    } else if (swap.targetEmployeeId.toString() === employeeProfileId.toString()) {
      if (swap.requesterShiftId) return swap.requesterShiftId;
    }
  }

  // 2. Regular shift assignment
  const assignment: any = await ShiftAssignmentModel.findOne({
    organizationId,
    employeeId: employeeProfileId,
    effectiveFrom: { $lte: date },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }],
  }).populate("shiftId");

  return assignment?.shiftId ?? null;
}
