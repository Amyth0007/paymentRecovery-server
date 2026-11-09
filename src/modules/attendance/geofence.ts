export type GeofenceResult = "inside" | "outside" | "ambiguous" | "low_accuracy";

export function haversineMeters(latA: number, lonA: number, latB: number, lonB: number): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(latB - latA);
  const dLon = radians(lonB - lonA);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateGeofence(distanceM: number, accuracyM: number, radiusM: number, accuracyThresholdM: number): GeofenceResult {
  if (accuracyM > accuracyThresholdM) return "low_accuracy";
  if (distanceM - accuracyM > radiusM) return "outside";
  if (distanceM + accuracyM > radiusM) return "ambiguous";
  return "inside";
}
