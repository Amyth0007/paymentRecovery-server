import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as userAccess from "../../modules/users/user-access.service.js";
import { requireActionPermission } from "./auth-guards.js";

const auth = {
  userId: "00000000-0000-4000-8000-000000000001",
  role: "sub_admin" as const,
  organizationId: "00000000-0000-4000-8000-000000000002",
  tokenVersion: 0,
  mustChangePassword: false,
};

async function runPermission(permission: "customers.archive" | "attendance.adjust", actionPermissions: string[]) {
  vi.spyOn(userAccess, "effectiveUserAccess").mockResolvedValue({ modules: [], actions: actionPermissions, customRoleName: null });

  const next = vi.fn();
  await new Promise<void>((resolve) => {
    requireActionPermission(permission)(
      { auth } as Request,
      {} as Response,
      (error) => { if (error) next(error); else next(); resolve(); },
    );
  });
  return next.mock.calls[0]?.[0];
}

describe("subadmin action permission guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allows an explicitly granted action", async () => {
    expect(await runPermission("customers.archive", ["customers.archive"])).toBeUndefined();
  });

  it("rejects an action that was not granted", async () => {
    const error = await runPermission("customers.archive", ["customers.view"]);
    expect(error).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("allows admins to bypass per-action grants", async () => {
    const next = vi.fn();
    await new Promise<void>((resolve) => {
      requireActionPermission("attendance.adjust")(
        { auth: { ...auth, role: "org_admin" } } as Request,
        {} as Response,
        (error) => { if (error) next(error); else next(); resolve(); },
      );
    });
    expect(next).toHaveBeenCalledWith();
  });
});
