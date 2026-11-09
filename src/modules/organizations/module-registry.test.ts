import { describe, expect, it } from "vitest";
import { isModuleEnabled } from "./module-registry.js";

describe("organization module defaults", () => {
  it("preserves existing product access when no module setting has been stored", () => {
    expect(isModuleEnabled(undefined, "customers")).toBe(true);
    expect(isModuleEnabled(undefined, "invoices")).toBe(true);
    expect(isModuleEnabled(undefined, "settings")).toBe(true);
  });

  it("keeps optional attendance disabled until a super admin enables it", () => {
    expect(isModuleEnabled(undefined, "attendance")).toBe(false);
    expect(isModuleEnabled(new Map([["attendance", true]]), "attendance")).toBe(true);
  });

  it("uses saved module choices over defaults", () => {
    expect(isModuleEnabled(new Map([["payments", false]]), "payments")).toBe(false);
  });
});
