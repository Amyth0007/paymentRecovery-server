export const MODULES = {
  reports: { name: "Dashboard & Reports", description: "Organization dashboards and business reports", defaultEnabled: true },
  customers: { name: "Customers", description: "Customer records and contact details", defaultEnabled: true },
  invoices: { name: "Invoices", description: "Invoice creation, documents, and acknowledgements", defaultEnabled: true },
  payments: { name: "Payments", description: "Payment records, reversals, and invoice ledgers", defaultEnabled: true },
  recovery: { name: "Recovery", description: "Recovery assignments, field visits, and call attempts", defaultEnabled: true },
  commitments: { name: "Commitments", description: "Payment commitments and follow-up tracking", defaultEnabled: true },
  gmail: { name: "Gmail integration", description: "Connect Gmail and send customer messages", defaultEnabled: true },
  settings: { name: "Workspace settings & team", description: "Organization profile and staff administration", defaultEnabled: true },
  attendance: { name: "Attendance", description: "Location-based attendance and history", defaultEnabled: false },
} as const;

export type ModuleKey = keyof typeof MODULES;

export function isModuleEnabled(modules: Map<string, boolean> | undefined, moduleKey: ModuleKey): boolean {
  return modules?.get(moduleKey) ?? MODULES[moduleKey].defaultEnabled;
}
