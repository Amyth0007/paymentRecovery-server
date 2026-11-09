import { describe, expect, it } from "vitest";
import { evaluateGeofence, haversineMeters } from "./geofence.js";

describe("attendance geofence", () => {
  it("returns zero distance for identical coordinates", () => {
    expect(haversineMeters(18.5204, 73.8567, 18.5204, 73.8567)).toBe(0);
  });

  it("allows a fix clearly inside the radius after accounting for reported accuracy", () => {
    expect(evaluateGeofence(85, 10, 100, 50)).toBe("inside");
  });

  it("rejects a fix clearly outside the radius", () => {
    expect(evaluateGeofence(160, 20, 100, 50)).toBe("outside");
  });

  it("requires retry when the accuracy circle overlaps the boundary", () => {
    expect(evaluateGeofence(95, 10, 100, 50)).toBe("ambiguous");
  });

  it("requires retry when GPS accuracy exceeds policy", () => {
    expect(evaluateGeofence(20, 51, 100, 50)).toBe("low_accuracy");
  });
});
