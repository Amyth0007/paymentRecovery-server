import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../database/connection.js";
vi.mock("../../database/connection.js", () => ({ db: { select: vi.fn(), transaction: vi.fn() } }));

/** A Drizzle-style query chain that resolves to `rows` however it is awaited. */
function rowsQuery(rows: unknown[]) {
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject) };
  return chain;
}

import * as auditService from "../audit-logs/audit.service.js";
import { importEmployeesFromWorkbook } from "./employee-import.service.js";

const actor = { userId: "00000000-0000-4000-8000-000000000001", role: "org_admin" as const, organizationId: "00000000-0000-4000-8000-000000000002", tokenVersion: 0, mustChangePassword: false };

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
    vi.mocked(db.select).mockImplementation((() => rowsQuery([])) as never);
    const insertValues = vi.fn(() => ({ returning: async () => [{ id: "employee-1" }] }));
    vi.mocked(db.transaction).mockImplementation((async (run: (tx: unknown) => unknown) => run({ insert: () => ({ values: insertValues }) })) as never);
    const result = await importEmployeesFromWorkbook(actor, actor.organizationId!, await workbookBuffer(), {} as never);
    expect(result).toEqual({ createdCount: 1, errors: [] });
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid rows without inserting partial employee data", async () => {
    vi.mocked(db.select).mockImplementation((() => rowsQuery([])) as never);
    const insert = vi.mocked(db.transaction);
    insert.mockClear();
    const result = await importEmployeesFromWorkbook(actor, actor.organizationId!, await workbookBuffer("unknown"), {} as never);
    expect(result.createdCount).toBe(0);
    expect(result.errors[0]?.row).toBe(2);
    expect(insert).not.toHaveBeenCalled();
  });
});
