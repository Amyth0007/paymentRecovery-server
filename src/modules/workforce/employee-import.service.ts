import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { DepartmentModel } from "./department.model.js";
import { DesignationModel } from "./designation.model.js";
import { WorkforceEmployeeModel } from "./employee.model.js";
import { employeeCreateSchema } from "./workforce.schemas.js";

function cellText(value: ExcelJS.CellValue): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && value && "text" in value) return String(value.text ?? "").trim();
  return String(value ?? "").trim();
}

export async function importEmployeesFromWorkbook(actor: AuthContext, organizationId: string, buffer: Buffer, meta: RequestMeta) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new AppError("VALIDATION_ERROR", "The workbook needs a header row and at least one employee row", 422);
  if (sheet.rowCount > 5001) throw new AppError("VALIDATION_ERROR", "Import is limited to 5,000 employee rows", 422);
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(cellText(cell.value).toLowerCase().replace(/\s+/g, ""), column));
  const required = ["employeenumber", "firstname", "joiningdate", "employmenttype"];
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) throw new AppError("VALIDATION_ERROR", `Missing required columns: ${missing.join(", ")}`, 422);
  const departments = await DepartmentModel.find({ organizationId, status: "active" }).select("name");
  const designations = await DesignationModel.find({ organizationId, status: "active" }).select("name");
  const departmentByName = new Map(departments.map((item) => [item.name.toLowerCase(), item._id]));
  const designationByName = new Map(designations.map((item) => [item.name.toLowerCase(), item._id]));
  const rows: Array<Record<string, unknown>> = [];
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    let hasData = false;
    row.eachCell({ includeEmpty: false }, (cell) => { if (cell.value !== null && cell.value !== undefined && cell.value !== "") hasData = true; });
    if (!hasData) continue;
    const get = (name: string) => { const column = headers.get(name.toLowerCase().replace(/\s+/g, "")); return column ? cellText(row.getCell(column).value) : ""; };
    const departmentName = get("department"); const designationName = get("designation");
    const departmentId = departmentName ? departmentByName.get(departmentName.toLowerCase()) : null;
    const designationId = designationName ? designationByName.get(designationName.toLowerCase()) : null;
    if (departmentName && !departmentId) errors.push({ row: rowNumber, message: `Unknown department: ${departmentName}` });
    if (designationName && !designationId) errors.push({ row: rowNumber, message: `Unknown designation: ${designationName}` });
    const candidate = { employeeNumber: get("employeeNumber"), firstName: get("firstName"), lastName: get("lastName"), email: get("email"), phone: get("phone"), dateOfBirth: get("dateOfBirth") || null, joiningDate: get("joiningDate"), employmentType: get("employmentType").toLowerCase().replace(/[ -]+/g, "_"), status: get("status") || "active", departmentId, designationId };
    const parsed = employeeCreateSchema.safeParse(candidate);
    if (!parsed.success) errors.push({ row: rowNumber, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    else {
      const number = parsed.data.employeeNumber.toUpperCase();
      if (seen.has(number)) errors.push({ row: rowNumber, message: `Duplicate employee number in workbook: ${number}` });
      seen.add(number); rows.push({ ...parsed.data, organizationId: new Types.ObjectId(organizationId) });
    }
  }
  if (errors.length) return { createdCount: 0, errors };
  if (!rows.length) throw new AppError("VALIDATION_ERROR", "No employee data rows were found", 422);
  const employeeNumbers: string[] = rows.map((row) => String(row.employeeNumber));
  const existing = await WorkforceEmployeeModel.find({ organizationId, employeeNumber: { $in: employeeNumbers } }).select("employeeNumber").lean();
  if (existing.length) throw new AppError("CONFLICT", `Employee numbers already exist: ${existing.map((item) => item.employeeNumber).join(", ")}`, 409);
  const created = await WorkforceEmployeeModel.insertMany(rows, { ordered: true });
  await recordAudit({ actor, action: "workforce.employee_imported", entityType: "workforce_employee_import", entityId: organizationId, organizationId, after: { createdCount: created.length, employeeNumbers }, meta });
  return { createdCount: created.length, errors: [] };
}
