function roundedRatio(numerator: bigint, denominator: bigint): number {
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Calculated amount exceeds the safe integer range");
  return Number(result);
}

export function calculateDailyAmountMinor(quantityThousandths: number, rateMinor: number): number {
  if (!Number.isSafeInteger(quantityThousandths) || quantityThousandths < 0 || !Number.isSafeInteger(rateMinor) || rateMinor < 0) throw new RangeError("Quantity and rate must be nonnegative safe integers");
  return roundedRatio(BigInt(quantityThousandths) * BigInt(rateMinor), 1000n);
}

export function calculatePercentageMinor(basisMinor: number, rateBasisPoints: number): number {
  if (!Number.isSafeInteger(basisMinor) || basisMinor < 0 || !Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new RangeError("Basis and rate must be nonnegative safe integers");
  return roundedRatio(BigInt(basisMinor) * BigInt(rateBasisPoints), 10000n);
}

export function calculateOvertimeAmountMinor(minutes: number, hourlyRateMinor: number, multiplierBasisPoints: number): number {
  if (![minutes, hourlyRateMinor, multiplierBasisPoints].every(Number.isSafeInteger) || minutes < 0 || hourlyRateMinor < 0 || multiplierBasisPoints < 0) throw new RangeError("Overtime inputs must be nonnegative safe integers");
  return roundedRatio(BigInt(minutes) * BigInt(hourlyRateMinor) * BigInt(multiplierBasisPoints), 600000n);
}

export function calculateProRataMinor(amountMinor: number, partUnits: number, totalUnits: number): number {
  if (![amountMinor, partUnits, totalUnits].every(Number.isSafeInteger) || amountMinor < 0 || partUnits < 0 || totalUnits <= 0) throw new RangeError("Proration inputs must be safe integers and total units must be positive");
  return roundedRatio(BigInt(amountMinor) * BigInt(partUnits), BigInt(totalUnits));
}

export function calculateAttendanceBaseMinor(payBasis: "daily" | "shift" | "hourly", rateMinor: number, attendedDays: number, workedMinutes: number): number {
  if (![attendedDays, workedMinutes].every(Number.isSafeInteger) || attendedDays < 0 || workedMinutes < 0) throw new RangeError("Attendance quantities must be nonnegative safe integers");
  if (payBasis === "hourly") return calculateProRataMinor(rateMinor, workedMinutes, 60);
  return calculateDailyAmountMinor(attendedDays * 1000, rateMinor);
}
