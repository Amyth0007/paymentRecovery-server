import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkforceEmployeeModel } from "./employee.model.js";
import { DepartmentModel } from "./department.model.js";
import { DesignationModel } from "./designation.model.js";
import * as auditService from "../audit-logs/audit.service.js";
import { importEmployeesFromWorkbook } from "./employee-import.service.js";

const actor = { userId: "000000000000000000000001", role: "org_admin" as const, organizationId: "000000000000000000000002", tokenVersion: 0, mustChangePassword: false };

async function workbookBuffer(employmentType = "permanent") {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Employees");
  sheet.addRow(["employeeNumber", "firstName", "lastName", "joiningDate", "employmentType"]);
  sheet.addRow(["E-100", "Riya", "Shah", "2026-01-15", employmentType]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("workforce Excel employee import", () => {
  afterEach(() => vi.restoreAllMocks());

  it("validates and imports a complete workbook", async () => {
    vi.spyOn(auditService, "recordAudit").mockResolvedValue(undefined);
    vi.spyOn(DepartmentModel, "find").mockReturnValue({ select: vi.fn().mockResolvedValue([]) } as never);
    vi.spyOn(DesignationModel, "find").mockReturnValue({ select: vi.fn().mockResolvedValue([]) } as never);
    vi.spyOn(WorkforceEmployeeModel, "find").mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) } as never);
    vi.spyOn(WorkforceEmployeeModel, "insertMany").mockResolvedValue([{ _id: { toString: () => "employee-1" } }] as never);
    const result = await importEmployeesFromWorkbook(actor, actor.organizationId!, await workbookBuffer(), {} as never);
    expect(result).toEqual({ createdCount: 1, errors: [] });
    expect(WorkforceEmployeeModel.insertMany).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid rows without inserting partial employee data", async () => {
    vi.spyOn(DepartmentModel, "find").mockReturnValue({ select: vi.fn().mockResolvedValue([]) } as never);
    vi.spyOn(DesignationModel, "find").mockReturnValue({ select: vi.fn().mockResolvedValue([]) } as never);
    const insert = vi.spyOn(WorkforceEmployeeModel, "insertMany");
    const result = await importEmployeesFromWorkbook(actor, actor.organizationId!, await workbookBuffer("unknown"), {} as never);
    expect(result.createdCount).toBe(0);
    expect(result.errors[0]?.row).toBe(2);
    expect(insert).not.toHaveBeenCalled();
  });
});
