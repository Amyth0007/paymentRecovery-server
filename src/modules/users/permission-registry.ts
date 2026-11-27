export const ACTION_PERMISSIONS = [
  { key: "customers.view", module: "customers", name: "View customers" },
  { key: "customers.create", module: "customers", name: "Create customers" },
  { key: "customers.update", module: "customers", name: "Edit customers" },
  { key: "customers.archive", module: "customers", name: "Archive customers" },
  { key: "invoices.view", module: "invoices", name: "View invoices" },
  { key: "invoices.create", module: "invoices", name: "Create drafts" },
  { key: "invoices.update_draft", module: "invoices", name: "Edit drafts" },
  { key: "invoices.issue", module: "invoices", name: "Issue invoices" },
  { key: "invoices.cancel", module: "invoices", name: "Cancel invoices" },
  { key: "invoices.acknowledge", module: "invoices", name: "Record acknowledgements" },
  { key: "payments.view", module: "payments", name: "View payments and ledgers" },
  { key: "payments.record", module: "payments", name: "Record payments" },
  { key: "payments.reverse", module: "payments", name: "Reverse payments" },
  { key: "recovery.view", module: "recovery", name: "View assignments and visits" },
  { key: "recovery.assign", module: "recovery", name: "Create assignments" },
  { key: "recovery.manage", module: "recovery", name: "Manage assignments" },
  { key: "recovery.record_visit", module: "recovery", name: "Record visits and calls" },
  { key: "commitments.view", module: "commitments", name: "View commitments" },
  { key: "commitments.create", module: "commitments", name: "Record commitments" },
  { key: "commitments.cancel", module: "commitments", name: "Cancel commitments" },
  { key: "commitments.evaluate", module: "commitments", name: "Evaluate commitments" },
  { key: "reports.view", module: "reports", name: "View reports" },
  { key: "gmail.send", module: "gmail", name: "Send customer emails" },
  { key: "attendance.view", module: "attendance", name: "View my attendance" },
  { key: "attendance.view_all", module: "attendance", name: "View organization attendance" },
  { key: "attendance.manage_policy", module: "attendance", name: "Manage attendance rules" },
  { key: "attendance.manage_locations", module: "attendance", name: "Manage office locations" },
  { key: "attendance.adjust", module: "attendance", name: "Adjust attendance records" },
  { key: "attendance.guard_punch", module: "attendance", name: "Record employee check-in/out on the guard station" },
  { key: "attendance.review_corrections", module: "attendance", name: "Review correction requests" },
  { key: "workforce.view", module: "workforce", name: "View employee profiles" },
  { key: "workforce.manage_employees", module: "workforce", name: "Manage employee profiles" },
  { key: "workforce.manage_departments", module: "workforce", name: "Manage departments and designations" },
  { key: "workforce.view_shifts", module: "workforce", name: "View work schedules" },
  { key: "workforce.manage_shifts", module: "workforce", name: "Manage shifts and assignments" },
  { key: "payroll.view_compensation", module: "payroll", name: "View compensation setup" },
  { key: "payroll.manage_compensation", module: "payroll", name: "Manage components and salary structures" },
  { key: "payroll.view_earnings", module: "payroll", name: "View daily earnings" },
  { key: "payroll.manage_earnings", module: "payroll", name: "Create daily earning entries" },
  { key: "payroll.approve_earnings", module: "payroll", name: "Approve daily earnings" },
  { key: "overtime.view", module: "overtime", name: "View overtime records" },
  { key: "overtime.manage_policy", module: "overtime", name: "Manage overtime policy" },
  { key: "overtime.create", module: "overtime", name: "Record or request overtime" },
  { key: "overtime.approve", module: "overtime", name: "Approve overtime" },
  { key: "payroll.create_run", module: "payroll", name: "Preview payroll runs" },
  { key: "payroll.submit_run", module: "payroll", name: "Submit payroll for approval" },
  { key: "payroll.approve_run", module: "payroll", name: "Approve payroll runs" },
  { key: "payroll.finalize_run", module: "payroll", name: "Finalize and lock payroll" },
  { key: "payroll.record_payment", module: "payroll", name: "Record salary payments" },
  { key: "leave.view", module: "leave", name: "View leave balances and requests" },
  { key: "leave.manage_types", module: "leave", name: "Manage leave types and allocations" },
  { key: "leave.request", module: "leave", name: "Create leave requests" },
  { key: "leave.approve", module: "leave", name: "Approve or reject leave" },
  { key: "compliance.view", module: "compliance", name: "View compliance rule versions" },
  { key: "compliance.manage", module: "compliance", name: "Draft compliance rule versions" },
  { key: "visitors.view", module: "visitors", name: "View visitor registrations" },
  { key: "visitors.register", module: "visitors", name: "Register visitors" },
  { key: "visitors.manage_forms", module: "visitors", name: "Manage forms and registration passes" },
  { key: "visitors.check_in", module: "visitors", name: "Check visitors in" },
  { key: "visitors.check_out", module: "visitors", name: "Check visitors out" },
] as const;

export type ActionPermissionKey = (typeof ACTION_PERMISSIONS)[number]["key"];
export const ACTION_PERMISSION_KEYS = ACTION_PERMISSIONS.map((permission) => permission.key) as [ActionPermissionKey, ...ActionPermissionKey[]];

/**
 * Individual screens (menu pages) inside each module. Admins can hide screens a person does not need even
 * though the module is granted. Stored as a deny-list (`deniedScreens`) so access granted before screens
 * existed is unchanged. Screen visibility is enforced by the client router and menu; data access is still
 * governed by module and action permissions on the API.
 */
export const SCREENS = [
  { key: "reports.overview", module: "reports", name: "Overview dashboard" },
  { key: "reports.workforce", module: "reports", name: "Workforce reports" },
  { key: "customers.list", module: "customers", name: "Customers" },
  { key: "invoices.list", module: "invoices", name: "Invoices" },
  { key: "payments.list", module: "payments", name: "Payments" },
  { key: "recovery.list", module: "recovery", name: "Recovery assignments" },
  { key: "commitments.list", module: "commitments", name: "Commitments" },
  { key: "attendance.main", module: "attendance", name: "Attendance" },
  { key: "attendance.guard_station", module: "attendance", name: "Guard station punches" },
  { key: "workforce.employees", module: "workforce", name: "Employees" },
  { key: "workforce.shifts", module: "workforce", name: "Shifts & schedules" },
  { key: "payroll.earnings", module: "payroll", name: "Earnings & pay" },
  { key: "payroll.history", module: "payroll", name: "Payroll history" },
  { key: "overtime.main", module: "overtime", name: "Overtime" },
  { key: "leave.main", module: "leave", name: "Leave & approvals" },
  { key: "compliance.main", module: "compliance", name: "Compliance rules" },
  { key: "visitors.forms", module: "visitors", name: "Forms & passes" },
  { key: "visitors.register", module: "visitors", name: "Register a visitor" },
  { key: "visitors.checkin", module: "visitors", name: "Check in / out" },
  { key: "visitors.records", module: "visitors", name: "Registrations" },
  { key: "settings.main", module: "settings", name: "Settings & team" },
] as const;

export type ScreenKey = (typeof SCREENS)[number]["key"];
export const SCREEN_KEYS = SCREENS.map((screen) => screen.key) as [ScreenKey, ...ScreenKey[]];

/**
 * Keeps only known screens whose module is granted, and rejects hiding every screen of a granted module
 * (that would grant a module nobody can open – revoke the module instead).
 */
export function cleanDeniedScreens(deniedScreens: readonly string[] | undefined, grantedModules: readonly string[]): ScreenKey[] {
  const granted = new Set(grantedModules);
  const denied = [...new Set(deniedScreens ?? [])].filter((key): key is ScreenKey => SCREENS.some((screen) => screen.key === key && granted.has(screen.module)));
  for (const module of granted) {
    const moduleScreens = SCREENS.filter((screen) => screen.module === module);
    if (moduleScreens.length && moduleScreens.every((screen) => denied.includes(screen.key))) {
      throw new ScreenPermissionError(module);
    }
  }
  return denied;
}

export class ScreenPermissionError extends Error {
  constructor(readonly module: string) { super(`Keep at least one ${module} screen visible, or remove the ${module} module instead`); }
}
