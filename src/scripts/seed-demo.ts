/**
 * Demo data seeder.
 *
 * Builds a complete, realistic demo organization ("Vertex Distribution Pvt Ltd") covering every module:
 * team & roles, workforce, shifts, attendance (present / late / half-day / absent / leave / open shifts),
 * corrections, overtime, daily earnings, payroll runs (paid, partially paid, cancelled, draft), leave,
 * customers, invoices (draft / issued / cancelled, every aging bucket), payments (multi-invoice, cheque
 * bounces + reversals), recovery assignments (every status), visits, call attempts, commitments,
 * visitor forms / passes / registrations, compliance rules and an audit trail.
 *
 * All dates are relative to the day you run it, so dashboards ("overdue", "due today", "next 7 days",
 * "present today") always look current. Re-running deletes ONLY the demo organization and rebuilds it.
 * Other organizations are never touched.
 *
 *   npm run seed:demo
 *
 * Logins (password for all: Demo@12345) are printed at the end. Every email uses the reserved `.test`
 * domain so nothing can ever be delivered to a real mailbox.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { connectDatabase, db, disconnectDatabase } from "../database/connection.js";
import { databaseOptions } from "../database/options.js";
import * as t from "../database/schema.js";
import { hashPassword } from "../common/auth/password.js";
import type { AuthContext, TenantRole } from "../common/auth/auth-context.js";
import { MODULES } from "../modules/organizations/module-registry.js";
import { ACTION_PERMISSIONS } from "../modules/users/permission-registry.js";
import { calculateDailyAmountMinor, calculateOvertimeAmountMinor } from "../modules/workforce/payroll-calculations.js";
import {
  approvePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  finalizePayrollRun,
  recordPayrollPayment,
  submitPayrollRun,
} from "../modules/workforce/workforce.service.js";

// =====================================================================
// Configuration
// =====================================================================
const ORG_NAME = "Vertex Distribution Pvt Ltd";
const DOMAIN = "vertexdistribution.test";
const ADMIN_EMAIL = `admin@${DOMAIN}`;
const PASSWORD = "Demo@12345";

// =====================================================================
// Deterministic randomness (same data shape on every run)
// =====================================================================
let seedState = 20261127;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let x = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const chance = (p: number) => rand() < p;
const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[int(0, 15)]).join("");
const digits = (length: number) => Array.from({ length }, () => String(int(0, 9))).join("");
const letters = (length: number) => Array.from({ length }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[int(0, 23)]).join("");

// =====================================================================
// Dates (organization timezone is Asia/Kolkata, UTC+05:30)
// =====================================================================
const IST_OFFSET_MIN = 330;
const NOW = new Date();
const istDate = (value: Date) => new Date(value.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
const TODAY = istDate(NOW);
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const diffDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** IST wall-clock time on `date`, given as minutes after midnight (may exceed 1440 for next-day times). */
const atMin = (date: string, minutes: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (minutes - IST_OFFSET_MIN) * 60_000);
const hm = (value: string) => { const [h, m] = value.split(":").map(Number); return h! * 60 + m!; };
const at = (date: string, time: string, plus = 0) => atMin(date, hm(time) + plus);
const notFuture = (value: Date) => (value > NOW ? new Date(NOW.getTime() - 60_000) : value);
/** A business-hours timestamp on `date`, never in the future. */
const stamp = (date: string, from = "10:00", to = "18:00") => notFuture(atMin(date, int(hm(from), hm(to))));
function monthStart(offset: number): string {
  const [year, month] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}
const monthEnd = (start: string) => addDays(monthStart(diffMonths(start) + 1), -1);
function diffMonths(start: string): number {
  const [y1, m1] = TODAY.split("-").map(Number);
  const [y2, m2] = start.split("-").map(Number);
  return (y2! - y1!) * 12 + (m2! - m1!);
}
const M2_START = monthStart(-2);
const M2_END = monthEnd(M2_START);
const M1_START = monthStart(-1);
const M1_END = monthEnd(M1_START);
const M0_START = monthStart(0);
const M0_END = monthEnd(M0_START);
const ATTENDANCE_START = M2_START;
const YEAR = Number(TODAY.slice(0, 4));
const monthLabel = (start: string) => new Date(`${start}T12:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const fiscalYear = (date: string) => {
  const year = Number(date.slice(0, 4)) % 100;
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start).padStart(2, "0")}-${String(start + 1).padStart(2, "0")}`;
};
const isWorkday = (date: string) => weekday(date) !== 0;
const rupees = (value: number) => Math.round(value * 100);

// =====================================================================
// Insert helpers
// =====================================================================
async function insertMany(table: any, rows: any[], chunk = 400) {
  for (let index = 0; index < rows.length; index += chunk) {
    await db.insert(table).values(rows.slice(index, index + chunk));
  }
}

type AuditRow = typeof t.auditLogs.$inferInsert;
const audits: AuditRow[] = [];
let orgId = "";
function audit(actor: { id: string; role: string }, action: string, entityType: string, entityId: string, createdAt: Date, extra: { before?: unknown; after?: unknown; reason?: string } = {}) {
  audits.push({
    organizationId: orgId,
    actorId: actor.id,
    actorRole: actor.role,
    action,
    entityType,
    entityId,
    before: extra.before ?? null,
    after: extra.after ?? null,
    reason: extra.reason ?? null,
    ip: pick(["103.21.58.14", "49.36.112.87", "157.32.41.209", "106.193.77.120"]),
    userAgent: pick([
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    ]),
    createdAt: notFuture(createdAt),
  });
}

const avatarUrl = (name: string, background = "random") =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=256&background=${background}&color=ffffff&bold=true&format=png`;

// =====================================================================
// Static reference data
// =====================================================================
type LocKey = "pune" | "chakan" | "aurangabad";
const OFFICES: Record<LocKey, { name: string; address: string; lat: number; lng: number; radius: number }> = {
  pune: { name: "Pune HQ – Baner", address: "Office 501, Pride Purple Square, Baner, Pune, Maharashtra 411045", lat: 18.559, lng: 73.7868, radius: 150 },
  chakan: { name: "Chakan Warehouse", address: "Gat No. 312, MIDC Phase II, Chakan, Pune, Maharashtra 410501", lat: 18.7606, lng: 73.8636, radius: 250 },
  aurangabad: { name: "Aurangabad Branch", address: "Plot 14, Adalat Road, Aurangabad, Maharashtra 431001", lat: 19.8762, lng: 75.3433, radius: 120 },
};

type ShiftKey = "general" | "morning" | "evening" | "night" | "field";
const SHIFTS: Record<ShiftKey, { name: string; type: "fixed" | "rotational" | "night" | "flexible" | "split"; start: string; end: string; crosses: boolean; flex: number; breaks: t.ShiftBreak[] }> = {
  general: { name: "General Shift", type: "fixed", start: "09:30", end: "18:30", crosses: false, flex: 0, breaks: [{ name: "Lunch", startTime: "13:30", endTime: "14:00", paid: false }] },
  morning: { name: "Morning Shift", type: "rotational", start: "06:00", end: "14:00", crosses: false, flex: 0, breaks: [{ name: "Tea break", startTime: "10:00", endTime: "10:15", paid: true }] },
  evening: { name: "Evening Shift", type: "rotational", start: "14:00", end: "22:00", crosses: false, flex: 0, breaks: [{ name: "Dinner", startTime: "18:00", endTime: "18:30", paid: false }] },
  night: { name: "Night Shift", type: "night", start: "22:00", end: "06:00", crosses: true, flex: 0, breaks: [{ name: "Midnight meal", startTime: "02:00", endTime: "02:30", paid: false }] },
  field: { name: "Field Flexible", type: "flexible", start: "10:00", end: "19:00", crosses: false, flex: 60, breaks: [] },
};

type PayKey = "mgr" | "exec" | "assoc" | "junior" | "guard" | "daily" | "hourly" | "piece" | "intern";
type EmploymentType = (typeof t.EMPLOYMENT_TYPES)[number];
type Person = {
  key: string; first: string; last: string; role?: TenantRole; dept: string | null; desig: string | null; type: EmploymentType;
  joined: string; loc: LocKey; shift: ShiftKey | null; pay: PayKey | null; dob?: string; phone?: string;
  /** Final status (applied in stages so historical payroll runs include people who later left). */
  finalStatus?: "inactive" | "on_leave" | "terminated"; statusStage?: 1 | 2; lastDay?: string; userDisabled?: boolean; mustChange?: boolean;
  email: string; profileId: string; userId: string | null; photoId: string; notes?: string;
};

const P = (key: string, first: string, last: string, rest: Omit<Person, "key" | "first" | "last" | "email" | "profileId" | "userId" | "photoId">): Person => ({
  key, first, last, ...rest,
  email: rest.role ? `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@${DOMAIN}` : chance(0.4) ? `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, "")}@gmail.test` : "",
  profileId: randomUUID(), userId: null, photoId: randomUUID(),
});

const TEJAS_JOINED = addDays(M1_START, 13);
const PEOPLE: Person[] = [
  // ---- team members with app logins ----
  P("aditya", "Aditya", "Kulkarni", { role: "org_admin", dept: "MGMT", desig: "Managing Director", type: "permanent", joined: "2019-04-01", loc: "pune", shift: "general", pay: "mgr", dob: "1981-07-14" }),
  P("neha", "Neha", "Deshpande", { role: "sub_admin", dept: "ACC", desig: "Finance Manager", type: "permanent", joined: "2020-06-15", loc: "pune", shift: "general", pay: "mgr", dob: "1986-02-03" }),
  P("rohan", "Rohan", "Patil", { role: "sub_admin", dept: "HR", desig: "HR Manager", type: "permanent", joined: "2021-01-11", loc: "pune", shift: "general", pay: "exec", dob: "1988-11-21" }),
  P("priya", "Priya", "Joshi", { role: "accounts_manager", dept: "ACC", desig: "Accounts Executive", type: "permanent", joined: "2021-08-02", loc: "pune", shift: "general", pay: "exec", dob: "1992-05-09" }),
  P("sameer", "Sameer", "Shaikh", { role: "accounts_manager", dept: "ACC", desig: "Accounts Executive", type: "permanent", joined: "2022-03-14", loc: "aurangabad", shift: "general", pay: "exec", dob: "1990-09-30" }),
  P("vikram", "Vikram", "Jadhav", { role: "field_recovery", dept: "REC", desig: "Senior Recovery Officer", type: "permanent", joined: "2020-11-23", loc: "pune", shift: "field", pay: "exec", dob: "1987-01-17" }),
  P("sunil", "Sunil", "More", { role: "field_recovery", dept: "REC", desig: "Recovery Officer", type: "permanent", joined: "2022-07-04", loc: "pune", shift: "field", pay: "assoc", dob: "1993-03-25" }),
  P("anil", "Anil", "Pawar", { role: "field_recovery", dept: "REC", desig: "Recovery Officer", type: "permanent", joined: "2023-02-20", loc: "aurangabad", shift: "field", pay: "assoc", dob: "1994-08-12" }),
  P("ganesh", "Ganesh", "Shinde", { role: "field_recovery", dept: "REC", desig: "Recovery Officer", type: "contract", joined: "2024-05-06", loc: "pune", shift: "field", pay: "assoc", dob: "1997-12-02" }),
  P("rahul", "Rahul", "Gaikwad", { role: "field_recovery", dept: "REC", desig: "Recovery Officer", type: "permanent", joined: "2023-09-11", loc: "pune", shift: "field", pay: "assoc", finalStatus: "terminated", statusStage: 2, lastDay: addDays(M1_START, 9), userDisabled: true, notes: "Resigned. Full & final settlement processed with the last payroll." }),
  P("ramesh", "Ramesh", "Kale", { role: "guard", dept: "SEC", desig: "Security Guard", type: "permanent", joined: "2021-03-01", loc: "pune", shift: "morning", pay: "guard", dob: "1979-06-18" }),
  P("santosh", "Santosh", "Waghmare", { role: "guard", dept: "SEC", desig: "Security Guard", type: "contract", joined: "2022-10-17", loc: "chakan", shift: "evening", pay: "guard" }),
  P("balu", "Balu", "Thorat", { role: "guard", dept: "SEC", desig: "Security Guard", type: "contract", joined: "2023-06-05", loc: "chakan", shift: "night", pay: "guard" }),
  P("pooja", "Pooja", "Kadam", { role: "employee", dept: "HR", desig: "HR Executive", type: "permanent", joined: "2022-01-10", loc: "pune", shift: "general", pay: "assoc", dob: "1995-04-27" }),
  P("sneha", "Sneha", "Bhosale", { role: "employee", dept: "SAL", desig: "Sales Coordinator", type: "permanent", joined: "2021-12-01", loc: "pune", shift: "general", pay: "assoc", dob: "1994-10-05" }),
  P("amit", "Amit", "Chavan", { role: "employee", dept: "SAL", desig: "Sales Manager", type: "permanent", joined: "2020-09-14", loc: "pune", shift: "general", pay: "exec", dob: "1985-12-11" }),
  P("kiran", "Kiran", "Mane", { role: "employee", dept: "IT", desig: "IT Support Engineer", type: "permanent", joined: "2023-04-03", loc: "pune", shift: "general", pay: "assoc", dob: "1996-07-07" }),
  P("mahesh", "Mahesh", "Salunkhe", { role: "employee", dept: "WH", desig: "Warehouse Supervisor", type: "permanent", joined: "2019-08-19", loc: "chakan", shift: "morning", pay: "exec", dob: "1983-02-28" }),
  P("deepak", "Deepak", "Nikam", { role: "employee", dept: "WH", desig: "Driver", type: "permanent", joined: "2022-05-23", loc: "chakan", shift: "morning", pay: "junior" }),
  P("asha", "Asha", "Gokhale", { role: "employee", dept: "ACC", desig: "Accounts Assistant", type: "permanent", joined: "2024-01-08", loc: "pune", shift: "general", pay: "junior", dob: "1999-01-19" }),
  P("farhan", "Farhan", "Qureshi", { role: "employee", dept: "SAL", desig: "Sales Executive", type: "permanent", joined: "2023-11-20", loc: "aurangabad", shift: "general", pay: "assoc", dob: "1996-05-15" }),
  P("meera", "Meera", "Iyer", { role: "employee", dept: "PUR", desig: "Purchase Executive", type: "permanent", joined: "2021-06-21", loc: "pune", shift: "general", pay: "assoc", finalStatus: "on_leave", statusStage: 1, lastDay: addDays(M1_START, 3), notes: "On maternity leave." }),
  P("tejas", "Tejas", "Pawar", { role: "employee", dept: "SAL", desig: "Sales Executive", type: "permanent", joined: TEJAS_JOINED, loc: "pune", shift: "general", pay: "junior", mustChange: true, notes: "New joiner – onboarding in progress." }),
  // ---- employees without an app login (guard-station punches) ----
  P("sachin", "Sachin", "Gawade", { dept: "WH", desig: "Loader", type: "daily_wage", joined: "2022-02-14", loc: "chakan", shift: "morning", pay: "daily", phone: "+91 98220 41736" }),
  P("raju", "Raju", "Bansode", { dept: "WH", desig: "Loader", type: "daily_wage", joined: "2023-07-03", loc: "chakan", shift: "morning", pay: "daily", phone: "+91 97644 10982" }),
  P("vitthal", "Vitthal", "Kamble", { dept: "WH", desig: "Loader", type: "daily_wage", joined: "2021-10-25", loc: "chakan", shift: "morning", pay: "daily", finalStatus: "on_leave", statusStage: 2, lastDay: addDays(TODAY, -13), notes: "Medical leave – hand injury." }),
  P("dnyaneshwar", "Dnyaneshwar", "Lokhande", { dept: "WH", desig: "Loader", type: "daily_wage", joined: "2024-03-11", loc: "chakan", shift: "evening", pay: "daily" }),
  P("ashok", "Ashok", "Jagtap", { dept: "WH", desig: "Loader", type: "daily_wage", joined: "2022-08-08", loc: "chakan", shift: "morning", pay: "daily", finalStatus: "terminated", statusStage: 1, lastDay: addDays(M2_START, 19), notes: "Contract ended." }),
  P("sagar", "Sagar", "Dhumal", { dept: "WH", desig: "Loader", type: "temporary", joined: addDays(M2_START, 9), loc: "chakan", shift: "evening", pay: "daily", notes: "Temporary hire for festive season." }),
  P("sunita", "Sunita", "Kharat", { dept: "PKG", desig: "Packer", type: "contract", joined: "2022-04-04", loc: "chakan", shift: "general", pay: "piece" }),
  P("lata", "Lata", "Sonawane", { dept: "PKG", desig: "Packer", type: "contract", joined: "2023-01-16", loc: "chakan", shift: "general", pay: "piece" }),
  P("rekha", "Rekha", "Dhone", { dept: "PKG", desig: "Packer", type: "contract", joined: "2023-09-25", loc: "chakan", shift: "general", pay: "piece" }),
  P("manisha", "Manisha", "Pawale", { dept: "PKG", desig: "Packer", type: "contract", joined: "2024-02-12", loc: "chakan", shift: "general", pay: "piece", finalStatus: "inactive", statusStage: 2, lastDay: addDays(M0_START, 4) }),
  P("savita", "Savita", "Ingle", { dept: "PKG", desig: "Packer", type: "contract", joined: "2024-08-19", loc: "chakan", shift: "general", pay: "piece" }),
  P("imran", "Imran", "Sayyed", { dept: "WH", desig: "Driver", type: "permanent", joined: "2021-05-10", loc: "chakan", shift: "morning", pay: "junior", phone: "+91 99230 55871" }),
  P("prakash", "Prakash", "Rokade", { dept: "WH", desig: "Driver", type: "permanent", joined: "2020-12-07", loc: "pune", shift: "morning", pay: "junior" }),
  P("shobha", "Shobha", "Wagh", { dept: "HR", desig: "Housekeeping Staff", type: "contract", joined: "2022-06-01", loc: "pune", shift: "general", pay: "daily" }),
  P("kamal", "Kamal", "Hivrale", { dept: "HR", desig: "Housekeeping Staff", type: "contract", joined: "2023-03-20", loc: "pune", shift: "general", pay: "daily", finalStatus: "inactive", statusStage: 1, lastDay: M2_END }),
  P("riya", "Riya", "Sharma", { dept: "ACC", desig: "Accounts Assistant", type: "part_time", joined: "2025-07-01", loc: "pune", shift: "general", pay: "hourly", notes: "Part-time, 4 hours/day." }),
  P("arjun", "Arjun", "Menon", { dept: "IT", desig: "Intern", type: "intern", joined: "2026-06-15", loc: "pune", shift: "general", pay: "intern", notes: "Six-month internship." }),
  P("nikhil", "Nikhil", "Bendre", { dept: "SAL", desig: "Sales Executive", type: "freelance", joined: "2025-01-06", loc: "aurangabad", shift: null, pay: null, notes: "Commission-only freelancer; no fixed pay structure." }),
  P("shankar", "Shankar", "Mhaske", { dept: "SEC", desig: "Security Guard", type: "permanent", joined: "2020-02-03", loc: "chakan", shift: "night", pay: "guard" }),
  P("bhagyashree", "Bhagyashree", "Venkataraman-Subramaniam", { dept: null, desig: null, type: "contract", joined: "2025-09-01", loc: "pune", shift: "general", pay: "daily", notes: "Profile incomplete – department and designation not yet assigned." }),
];
const person = (key: string) => PEOPLE.find((item) => item.key === key)!;
person("aditya").email = ADMIN_EMAIL;

const DEPARTMENTS: Array<{ code: string; name: string; manager: string | null; status?: "inactive" }> = [
  { code: "MGMT", name: "Management", manager: "aditya" },
  { code: "ACC", name: "Accounts & Finance", manager: "neha" },
  { code: "SAL", name: "Sales", manager: "amit" },
  { code: "REC", name: "Field Recovery", manager: "vikram" },
  { code: "WH", name: "Warehouse & Logistics", manager: "mahesh" },
  { code: "PKG", name: "Packaging", manager: "mahesh" },
  { code: "SEC", name: "Security", manager: "ramesh" },
  { code: "HR", name: "HR & Administration", manager: "rohan" },
  { code: "IT", name: "IT Support", manager: "kiran" },
  { code: "PUR", name: "Purchase", manager: "neha" },
  { code: "LEG", name: "Legacy Projects", manager: null, status: "inactive" },
];
const DESIGNATIONS = [
  ["Managing Director", "Leads the company"], ["Finance Manager", "Owns receivables, payables and reporting"], ["HR Manager", "People operations and payroll"],
  ["Accounts Executive", "Invoicing, receipts and reconciliation"], ["Accounts Assistant", "Data entry and filing"], ["Sales Manager", "Leads the sales team"],
  ["Sales Executive", "Dealer and retailer sales"], ["Sales Coordinator", "Order desk"], ["HR Executive", "Attendance, leave and onboarding"],
  ["Senior Recovery Officer", "Leads collections on high-value accounts"], ["Recovery Officer", "Field collections"], ["Warehouse Supervisor", "Runs warehouse operations"],
  ["Loader", "Loading and unloading"], ["Packer", "Packaging line"], ["Driver", "Delivery vehicle driver"], ["Security Guard", "Gate and premises security"],
  ["Housekeeping Staff", "Office upkeep"], ["IT Support Engineer", "Hardware, network and software support"], ["Intern", "Trainee"], ["Purchase Executive", "Vendor purchasing"],
] as const;

// =====================================================================
// Main
// =====================================================================
const env = loadEnv();
await connectDatabase({ ...databaseOptions(env), runMigrations: false });
console.log(`\nSeeding demo organization "${ORG_NAME}" (today = ${TODAY}, IST)…`);

const [superAdmin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "super_admin")).limit(1);
if (!superAdmin) throw new Error("No platform super admin found. Start the API once so it is created, then re-run.");

// ---------- 0. remove the previous demo organization (and only that) ----------
{
  const [conflict] = await db.select({ organizationId: t.users.organizationId }).from(t.users).where(eq(t.users.email, ADMIN_EMAIL)).limit(1);
  const previous = await db.select({ id: t.organizations.id }).from(t.organizations).where(eq(t.organizations.name, ORG_NAME));
  if (conflict && !previous.some((org) => org.id === conflict.organizationId)) {
    throw new Error(`${ADMIN_EMAIL} already belongs to another organization; refusing to touch it.`);
  }
  for (const org of previous) {
    const [demoAdmin] = await db.select({ id: t.users.id }).from(t.users).where(and(eq(t.users.organizationId, org.id), like(t.users.email, `%@${DOMAIN}`))).limit(1);
    if (!demoAdmin) { console.log(`  Skipping organization ${org.id}: same name but not created by this seeder.`); continue; }
    await db.delete(t.auditLogs).where(eq(t.auditLogs.organizationId, org.id));
    await db.delete(t.organizations).where(eq(t.organizations.id, org.id));
    console.log(`  Removed previous demo organization ${org.id}`);
  }
}

// ---------- 1. organization & subscription ----------
orgId = randomUUID();
const ORG_CREATED = at(addDays(TODAY, -245), "11:20");
await db.insert(t.organizations).values({
  id: orgId,
  name: ORG_NAME,
  legalName: "Vertex Distribution Private Limited",
  address: OFFICES.pune.address,
  gstin: "27AAKCV4821M1Z5",
  timezone: "Asia/Kolkata",
  showGuides: false,
  currency: "INR",
  status: "active",
  settings: { ...t.DEFAULT_ORGANIZATION_SETTINGS, commitmentGraceDays: 2, fieldLocationCapture: "optional" },
  modules: Object.fromEntries(Object.keys(MODULES).map((key) => [key, true])),
  createdBy: superAdmin.id,
  createdAt: ORG_CREATED,
});
{
  let [plan] = await db.select().from(t.subscriptionPlans).where(eq(t.subscriptionPlans.code, "growth")).limit(1);
  plan ??= (await db.insert(t.subscriptionPlans).values({ code: "growth", name: "Growth", description: "Payment recovery, workforce and visitor management for growing teams" }).returning())[0]!;
  await db.insert(t.organizationSubscriptions).values({ organizationId: orgId, planId: plan.id, status: "active", startedOn: istDate(ORG_CREATED), notes: "Annual plan – demo account" });
}

// ---------- 2. custom roles & users ----------
const actionsFor = (modules: string[]) => ACTION_PERMISSIONS.filter((item) => modules.includes(item.module)).map((item) => item.key);
const passwordHash = await hashPassword(PASSWORD);
const admin = person("aditya");
for (const item of PEOPLE) if (item.role) item.userId = randomUUID();
const adminActor = { id: admin.userId!, role: "org_admin" };

const accountsHeadModules = ["customers", "invoices", "payments", "recovery", "commitments", "reports", "gmail", "attendance", "leave", "payroll"];
const hrModules = ["workforce", "attendance", "leave", "overtime", "payroll", "compliance"];
const roleAccountsHead = randomUUID();
function addTime(base: Date, minutes: number) { return new Date(base.getTime() + minutes * 60_000); }

const ROLE_MODULES: Record<string, string[]> = {
  accounts_manager: ["customers", "invoices", "payments", "recovery", "commitments", "reports", "gmail", "attendance", "leave", "payroll", "overtime"],
  field_recovery: ["customers", "invoices", "recovery", "commitments", "attendance", "leave", "payroll", "overtime"],
  employee: ["attendance", "leave", "payroll", "overtime", "workforce"],
  guard: ["attendance", "visitors"],
};
const deptIds = Object.fromEntries(DEPARTMENTS.map((item) => [item.code, randomUUID()]));
const locIds: Record<LocKey, string> = { pune: randomUUID(), chakan: randomUUID(), aurangabad: randomUUID() };
const rohanModules = ["workforce", "attendance", "leave", "overtime", "payroll"];
const userRows: Array<typeof t.users.$inferInsert> = PEOPLE.filter((item) => item.role).map((item, index) => {
  const createdAt = item.key === "tejas" ? at(TEJAS_JOINED, "10:05") : addTime(ORG_CREATED, 10 + index * 7);
  const base = {
    id: item.userId!, organizationId: orgId, email: item.email, name: `${item.first} ${item.last}`, passwordHash, role: item.role!,
    status: item.userDisabled ? ("disabled" as const) : ("active" as const), mustChangePassword: Boolean(item.mustChange), tokenVersion: item.userDisabled ? 1 : 0,
    lastLoginAt: item.userDisabled ? at(item.lastDay!, "18:02") : item.mustChange ? null : stamp(addDays(TODAY, -int(0, 3)), "09:00", "11:00"),
    createdAt, updatedAt: createdAt,
  };
  if (item.role === "org_admin") return { ...base, modulePermissions: {}, modulePermissionsConfigured: false };
  if (item.key === "neha") return { ...base, modulePermissions: Object.fromEntries(accountsHeadModules.map((key) => [key, true])), modulePermissionsConfigured: true, actionPermissions: actionsFor(accountsHeadModules) };
  if (item.key === "rohan") return { ...base, modulePermissions: Object.fromEntries(rohanModules.map((key) => [key, true])), modulePermissionsConfigured: true, actionPermissions: actionsFor(rohanModules), workforceScope: { mode: "selected" as const, departmentIds: [deptIds.WH!, deptIds.PKG!, deptIds.SEC!, deptIds.HR!], locationIds: [] } };
  const modules = ROLE_MODULES[item.role!]!;
  return { ...base, modulePermissions: Object.fromEntries(modules.map((key) => [key, true])), modulePermissionsConfigured: true };
});
await insertMany(t.users, userRows);
await insertMany(t.customRoles, [
  { id: roleAccountsHead, organizationId: orgId, name: "Accounts Head", description: "Full receivables control: customers, invoicing, receipts, recovery and reports", modulePermissions: accountsHeadModules, actionPermissions: actionsFor(accountsHeadModules), createdBy: admin.userId!, updatedBy: admin.userId!, createdAt: addTime(ORG_CREATED, 30) },
  { organizationId: orgId, name: "HR & Payroll Executive", description: "Employee records, attendance, leave, overtime and payroll processing", modulePermissions: hrModules, actionPermissions: actionsFor(hrModules).filter((key) => key !== "payroll.finalize_run"), createdBy: admin.userId!, updatedBy: admin.userId!, createdAt: addTime(ORG_CREATED, 35) },
  { organizationId: orgId, name: "Statutory Auditor (FY25-26)", description: "Read-only access for the annual audit – archived after sign-off", modulePermissions: ["reports", "invoices", "payments"], actionPermissions: ["reports.view", "invoices.view", "payments.view"], status: "archived", createdBy: admin.userId!, updatedBy: admin.userId!, createdAt: addTime(ORG_CREATED, 40) },
]);
await db.update(t.users).set({ customRoleId: roleAccountsHead }).where(eq(t.users.id, person("neha").userId!));
for (const row of userRows) audit(adminActor, "user.created", "user", row.id!, row.createdAt as Date, { after: { email: row.email, role: row.role } });
const U = (key: string) => ({ id: person(key).userId!, role: person(key).role! as string });

// ---------- 3. offices, attendance policy, departments, designations ----------
await insertMany(t.officeLocations, [
  ...(Object.keys(OFFICES) as LocKey[]).map((key) => ({ id: locIds[key], organizationId: orgId, name: OFFICES[key].name, address: OFFICES[key].address, latitude: OFFICES[key].lat, longitude: OFFICES[key].lng, geofenceRadiusM: OFFICES[key].radius, createdAt: addTime(ORG_CREATED, 60) })),
  { organizationId: orgId, name: "Nashik Depot (closed)", address: "Satpur MIDC, Nashik, Maharashtra 422007", latitude: 19.9975, longitude: 73.7898, geofenceRadiusM: 200, status: "inactive" as const, createdAt: addTime(ORG_CREATED, 61) },
]);
await db.insert(t.attendancePolicies).values({ organizationId: orgId, expectedCheckIn: "09:30", expectedCheckOut: "18:30", gracePeriodMinutes: 10, halfDayHours: 4, gpsAccuracyThresholdM: 50, locationVerificationRequired: false, weeklyHolidays: [0], correctionRequestsEnabled: true, createdAt: addTime(ORG_CREATED, 62) });
const desigIds = Object.fromEntries(DESIGNATIONS.map(([name]) => [name, randomUUID()]));
await insertMany(t.designations, [
  ...DESIGNATIONS.map(([name, description]) => ({ id: desigIds[name], organizationId: orgId, name, description, createdAt: addTime(ORG_CREATED, 70) })),
  { organizationId: orgId, name: "Telecaller", description: "Role merged into Recovery Officer", status: "inactive" as const, createdAt: addTime(ORG_CREATED, 71) },
]);
await insertMany(t.departments, DEPARTMENTS.map((item) => ({ id: deptIds[item.code], organizationId: orgId, name: item.name, code: item.code, status: item.status ?? ("active" as const), createdAt: addTime(ORG_CREATED, 72) })));

// ---------- 4. workforce employees ----------
const managerOf = (item: Person) => {
  const dept = DEPARTMENTS.find((d) => d.code === item.dept);
  const managerKey = dept?.manager && dept.manager !== item.key ? dept.manager : item.key === "aditya" ? null : "aditya";
  return managerKey ? person(managerKey).profileId : null;
};
await insertMany(t.workforceEmployees, PEOPLE.map((item, index) => ({
  id: item.profileId, organizationId: orgId, userId: item.userId, employeeNumber: `VDX${String(index + 1).padStart(4, "0")}`,
  firstName: item.first, lastName: item.last, email: item.email, phone: item.phone ?? (chance(0.85) ? `+91 ${pick(["98", "97", "99", "88", "70", "86"])}${digits(3)} ${digits(5)}` : ""),
  dateOfBirth: item.dob ?? (chance(0.6) ? `${int(1975, 2003)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}` : null),
  joiningDate: item.joined, employmentType: item.type, status: "active" as const,
  departmentId: item.dept ? deptIds[item.dept] : null, designationId: item.desig ? desigIds[item.desig] : null,
  reportingManagerId: managerOf(item), workLocationId: locIds[item.loc], notes: item.notes ?? "",
  createdAt: item.key === "tejas" ? at(TEJAS_JOINED, "10:10") : addTime(ORG_CREATED, 120 + index), updatedAt: addTime(ORG_CREATED, 120 + index),
})));
await Promise.all(DEPARTMENTS.filter((item) => item.manager).map((item) => db.update(t.departments).set({ managerEmployeeId: person(item.manager!).profileId }).where(eq(t.departments.id, deptIds[item.code]!))));
audit(adminActor, "workforce.team_members_imported", "workforce_employee_import", orgId, addTime(ORG_CREATED, 125), { after: { createdCount: PEOPLE.filter((p) => p.userId).length, skippedCount: 0 } });
for (const item of PEOPLE.filter((p) => !p.userId)) audit(U("rohan"), "workforce.employee_created", "workforce_employee", item.profileId, addTime(ORG_CREATED, 130), { after: { firstName: item.first, lastName: item.last, employmentType: item.type } });

// ---------- 5. shifts & assignments ----------
const SHIFT_FROM = "2026-01-01";
const shiftIds = Object.fromEntries((Object.keys(SHIFTS) as ShiftKey[]).map((key) => [key, randomUUID()])) as Record<ShiftKey, string>;
await insertMany(t.shifts, [
  ...(Object.keys(SHIFTS) as ShiftKey[]).map((key) => ({ id: shiftIds[key], organizationId: orgId, name: SHIFTS[key].name, shiftType: SHIFTS[key].type, startTime: SHIFTS[key].start, endTime: SHIFTS[key].end, crossesMidnight: SHIFTS[key].crosses, flexibleWindowMinutes: SHIFTS[key].flex, breaks: SHIFTS[key].breaks, weeklyOffs: [0], effectiveFrom: SHIFT_FROM, createdAt: addTime(ORG_CREATED, 140) })),
  { organizationId: orgId, name: "Split Shift – Retail Counter", shiftType: "split" as const, startTime: "08:00", endTime: "20:00", breaks: [{ name: "Afternoon gap", startTime: "12:00", endTime: "16:00", paid: false }], weeklyOffs: [0, 3], effectiveFrom: SHIFT_FROM, effectiveTo: "2026-06-30", status: "inactive" as const, createdAt: addTime(ORG_CREATED, 141) },
]);
const RAMESH_ROTATION = addDays(M1_START, 14);
function shiftFor(item: Person, date: string): ShiftKey | null {
  if (item.key === "ramesh") return date >= RAMESH_ROTATION ? "evening" : "morning";
  return item.shift;
}
const shiftAssignmentRows: Array<typeof t.shiftAssignments.$inferInsert> = [];
for (const item of PEOPLE) {
  if (!item.shift) continue;
  const from = item.joined > SHIFT_FROM ? item.joined : SHIFT_FROM;
  if (item.key === "ramesh") {
    shiftAssignmentRows.push({ organizationId: orgId, employeeId: item.profileId, shiftId: shiftIds.morning, effectiveFrom: from, effectiveTo: addDays(RAMESH_ROTATION, -1), assignedBy: U("rohan").id, createdAt: addTime(ORG_CREATED, 150) });
    shiftAssignmentRows.push({ organizationId: orgId, employeeId: item.profileId, shiftId: shiftIds.evening, effectiveFrom: RAMESH_ROTATION, assignedBy: U("rohan").id, createdAt: at(addDays(RAMESH_ROTATION, -3), "16:20") });
    continue;
  }
  shiftAssignmentRows.push({ organizationId: orgId, employeeId: item.profileId, shiftId: shiftIds[item.shift], effectiveFrom: from, assignedBy: U("rohan").id, createdAt: item.key === "tejas" ? at(TEJAS_JOINED, "11:00") : addTime(ORG_CREATED, 150) });
}
await insertMany(t.shiftAssignments, shiftAssignmentRows);

// ---------- 6. compensation ----------
const COMP_FROM = "2026-04-01";
type ComponentDef = { code: string; name: string; kind: t.ComponentKind; calculation: "fixed" | "percentage"; amount?: number; bp?: number; basis?: string; status?: "inactive"; to?: string };
const COMPONENTS: ComponentDef[] = [
  { code: "HRA", name: "House Rent Allowance", kind: "earning", calculation: "percentage", bp: 4000, basis: "BASE" },
  { code: "CONV", name: "Conveyance Allowance", kind: "earning", calculation: "fixed", amount: 1600 },
  { code: "SPL", name: "Special Allowance", kind: "earning", calculation: "fixed", amount: 2500 },
  { code: "PF_EE", name: "Provident Fund (Employee)", kind: "deduction", calculation: "percentage", bp: 1200, basis: "BASE" },
  { code: "PT", name: "Professional Tax", kind: "deduction", calculation: "fixed", amount: 200 },
  { code: "PF_ER", name: "Provident Fund (Employer)", kind: "employer_contribution", calculation: "percentage", bp: 1200, basis: "BASE" },
  { code: "ESI_ER", name: "ESI (Employer)", kind: "employer_contribution", calculation: "percentage", bp: 325, basis: "BASE" },
  { code: "MED", name: "Medical Allowance (discontinued)", kind: "earning", calculation: "fixed", amount: 1250, status: "inactive", to: "2026-03-31" },
];
const componentIds = Object.fromEntries(COMPONENTS.map((item) => [item.code, randomUUID()]));
await insertMany(t.compensationComponents, COMPONENTS.map((item, index) => ({
  id: componentIds[item.code], organizationId: orgId, code: item.code, name: item.name, kind: item.kind, calculation: item.calculation,
  amountMinor: rupees(item.amount ?? 0), rateBasisPoints: item.bp ?? 0, basisComponentCode: item.basis ?? "",
  effectiveFrom: item.to ? "2025-04-01" : COMP_FROM, effectiveTo: item.to ?? null, status: item.status ?? ("active" as const), createdAt: addTime(ORG_CREATED, 200 + index),
})));
const line = (code: string): t.StructureLine => {
  const item = COMPONENTS.find((c) => c.code === code)!;
  return { componentId: componentIds[code]!, code, name: item.name, kind: item.kind, calculation: item.calculation, amountMinor: rupees(item.amount ?? 0), rateBasisPoints: item.bp ?? 0, basisComponentCode: item.basis ?? "" };
};
type StructureDef = { key: PayKey | "old"; name: string; mode: "simple" | "professional"; basis: "monthly" | "daily" | "hourly" | "shift" | "piece"; base: number; lines: string[]; from?: string; to?: string; status?: "inactive" };
const STRUCTURES: StructureDef[] = [
  { key: "mgr", name: "Manager Band", mode: "professional", basis: "monthly", base: 85000, lines: ["HRA", "CONV", "SPL", "PF_EE", "PT", "PF_ER"] },
  { key: "exec", name: "Executive Band", mode: "professional", basis: "monthly", base: 40000, lines: ["HRA", "CONV", "SPL", "PF_EE", "PT", "PF_ER"] },
  { key: "assoc", name: "Associate Band", mode: "professional", basis: "monthly", base: 24000, lines: ["HRA", "CONV", "PF_EE", "PT", "PF_ER"] },
  { key: "junior", name: "Junior Band", mode: "professional", basis: "monthly", base: 15500, lines: ["HRA", "PF_EE", "PT", "PF_ER", "ESI_ER"] },
  { key: "guard", name: "Security – Per Shift", mode: "simple", basis: "shift", base: 850, lines: [] },
  { key: "daily", name: "Daily Wage – Warehouse", mode: "simple", basis: "daily", base: 700, lines: [] },
  { key: "hourly", name: "Part-time Hourly", mode: "simple", basis: "hourly", base: 220, lines: [] },
  { key: "piece", name: "Piece Rate – Packaging", mode: "simple", basis: "piece", base: 0, lines: [] },
  { key: "intern", name: "Intern Stipend", mode: "simple", basis: "monthly", base: 12000, lines: [] },
  { key: "old", name: "Associate Band FY25-26 (retired)", mode: "professional", basis: "monthly", base: 21000, lines: [], from: "2025-04-01", to: "2026-03-31", status: "inactive" },
];
const structureRows = STRUCTURES.map((item, index) => ({
  id: randomUUID(), organizationId: orgId, name: item.name, mode: item.mode, payBasis: item.basis, baseRateMinor: rupees(item.base),
  components: item.lines.map(line), effectiveFrom: item.from ?? COMP_FROM, effectiveTo: item.to ?? null, status: item.status ?? ("active" as const), createdAt: addTime(ORG_CREATED, 220 + index),
}));
await insertMany(t.payStructures, structureRows);
const structureByKey = (key: string) => structureRows[STRUCTURES.findIndex((item) => item.key === key)]!;
const snapshotOf = (structure: (typeof structureRows)[number], capturedAt: Date) => ({ structureId: structure.id, name: structure.name, mode: structure.mode, payBasis: structure.payBasis, baseRateMinor: structure.baseRateMinor, components: structure.components, effectiveFrom: structure.effectiveFrom, capturedAt: capturedAt.toISOString() });
const SUNIL_PROMOTION = addDays(M1_START, 14);
const compRows: Array<typeof t.compensationAssignments.$inferInsert> = [];
for (const item of PEOPLE) {
  if (!item.pay) continue;
  const from = item.joined > COMP_FROM ? item.joined : COMP_FROM;
  const created = item.key === "tejas" ? at(TEJAS_JOINED, "11:30") : at(COMP_FROM, "10:00", int(0, 120));
  if (item.key === "amit") {
    compRows.push({ organizationId: orgId, employeeId: item.profileId, structureId: structureByKey("old").id, effectiveFrom: "2025-04-01", effectiveTo: "2026-03-31", assignedBy: admin.userId!, rateSnapshot: snapshotOf(structureByKey("old"), addTime(ORG_CREATED, 230)), createdAt: addTime(ORG_CREATED, 230) });
  }
  if (item.key === "sunil") {
    compRows.push({ organizationId: orgId, employeeId: item.profileId, structureId: structureByKey("assoc").id, effectiveFrom: from, effectiveTo: addDays(SUNIL_PROMOTION, -1), assignedBy: admin.userId!, rateSnapshot: snapshotOf(structureByKey("assoc"), created), createdAt: created });
    const promoted = at(addDays(SUNIL_PROMOTION, -2), "15:40");
    compRows.push({ organizationId: orgId, employeeId: item.profileId, structureId: structureByKey("exec").id, effectiveFrom: SUNIL_PROMOTION, assignedBy: admin.userId!, rateSnapshot: snapshotOf(structureByKey("exec"), promoted), createdAt: promoted });
    continue;
  }
  compRows.push({ organizationId: orgId, employeeId: item.profileId, structureId: structureByKey(item.pay).id, effectiveFrom: from, assignedBy: admin.userId!, rateSnapshot: snapshotOf(structureByKey(item.pay), created), createdAt: created });
}
await insertMany(t.compensationAssignments, compRows);
for (const row of compRows) audit(adminActor, "payroll.compensation_assigned", "compensation_assignment", row.employeeId, row.createdAt as Date, { after: { employeeId: row.employeeId, structureId: row.structureId, effectiveFrom: row.effectiveFrom } });

// ---------- 7. leave types, requests, balances ----------
const LEAVE_TYPES = [
  { code: "CL", name: "Casual Leave", paid: true, days: 12 },
  { code: "SL", name: "Sick Leave", paid: true, days: 8 },
  { code: "EL", name: "Earned Leave", paid: true, days: 15 },
  { code: "COMP", name: "Compensatory Off", paid: true, days: 6 },
  { code: "LOP", name: "Loss of Pay", paid: false, days: 0 },
  { code: "MAT", name: "Maternity Leave", paid: true, days: 182 },
  { code: "WFH", name: "Work From Home (retired)", paid: true, days: 24, status: "inactive" as const },
];
const leaveTypeIds = Object.fromEntries(LEAVE_TYPES.map((item) => [item.code, randomUUID()]));
await insertMany(t.leaveTypes, LEAVE_TYPES.map((item) => ({ id: leaveTypeIds[item.code], organizationId: orgId, code: item.code, name: item.name, paid: item.paid, annualEntitlementDays: item.days, status: item.status ?? ("active" as const), createdAt: addTime(ORG_CREATED, 300) })));

type LeaveRow = typeof t.leaveRequests.$inferInsert;
const leaveRows: LeaveRow[] = [];
/** Full-day (or half-day) leave dates per profile, used to keep attendance consistent. */
const leaveDays = new Map<string, Map<string, number>>();
const busy = new Map<string, Array<[string, string]>>();
const workdaysIn = (start: string, end: string) => { let count = 0; for (let d = start; d <= end; d = addDays(d, 1)) if (isWorkday(d)) count++; return count; };
function addLeave(item: Person, type: string, start: string, end: string, status: "approved" | "pending" | "rejected" | "cancelled", reason: string, opts: { days?: number; comment?: string } = {}) {
  if (end < start || start.slice(0, 4) !== end.slice(0, 4) || start < item.joined) return false;
  if (status === "approved" && start >= M2_START && start.slice(0, 7) !== end.slice(0, 7) && type !== "MAT") return false;
  const ranges = busy.get(item.profileId) ?? [];
  if ((status === "approved" || status === "pending") && ranges.some(([s, e]) => s <= end && e >= start)) return false;
  const days = opts.days ?? workdaysIn(start, end);
  if (days <= 0) return false;
  const created = notFuture(at(addDays(start, -int(2, 12)), "10:00", int(0, 420)));
  const reviewer = item.dept === "SEC" || item.dept === "WH" || item.dept === "PKG" || item.dept === "HR" ? U("rohan") : item.key === "neha" || item.key === "rohan" ? adminActor : pick([U("rohan"), adminActor]);
  const reviewed = status === "approved" || status === "rejected" ? notFuture(addTime(created, int(60, 2880))) : null;
  const id = randomUUID();
  leaveRows.push({ id, organizationId: orgId, employeeId: item.profileId, leaveTypeId: leaveTypeIds[type]!, startDate: start, endDate: end, days, reason, status, reviewedBy: reviewed ? reviewer.id : null, reviewedAt: reviewed, reviewComment: opts.comment ?? "", createdAt: created, updatedAt: reviewed ?? created });
  if (status === "approved" || status === "pending") ranges.push([start, end]);
  busy.set(item.profileId, ranges);
  if (status === "approved") {
    const map = leaveDays.get(item.profileId) ?? new Map<string, number>();
    let remaining = days;
    for (let d = start; d <= end && remaining > 0; d = addDays(d, 1)) if (isWorkday(d)) { map.set(d, Math.min(1, remaining)); remaining -= Math.min(1, remaining); }
    leaveDays.set(item.profileId, map);
  }
  audit({ id: item.userId ?? reviewer.id, role: item.role ?? "org_admin" }, "leave.requested", "leave_request", id, created, { after: { leaveTypeId: leaveTypeIds[type], startDate: start, endDate: end, days, reason } });
  if (reviewed) audit(reviewer, `leave.${status}`, "leave_request", id, reviewed, { after: { status }, reason: opts.comment });
  return true;
}
const LEAVE_REASONS: Record<string, string[]> = {
  CL: ["Family function in native place", "Personal work at bank", "Child's school annual day", "House shifting", "Attending a wedding in Satara"],
  SL: ["Viral fever", "Dental procedure", "Migraine – doctor advised rest", "Food poisoning", "Back pain, physiotherapy session"],
  EL: ["Family vacation to Goa", "Visiting parents in Kerala", "Pilgrimage to Pandharpur", "Annual holiday"],
  COMP: ["Comp-off for Sunday stock audit", "Comp-off for year-end closing weekend"],
};
const randomWorkday = (from: string, to: string) => { for (let i = 0; i < 30; i++) { const d = addDays(from, int(0, Math.max(0, diffDays(from, to)))); if (isWorkday(d)) return d; } return from; };
for (const item of PEOPLE.filter((p) => p.userId && p.key !== "tejas")) {
  const lastDay = item.lastDay ?? TODAY;
  // earlier this year
  for (let i = 0; i < int(1, 3); i++) {
    const start = randomWorkday(`${YEAR}-01-05`, addDays(M2_START, -12));
    const type = pick(["CL", "SL", "EL", "CL"]);
    addLeave(item, type, start, addDays(start, int(0, 2)), "approved", pick(LEAVE_REASONS[type]!));
  }
  // inside the payroll window
  for (let i = 0; i < int(0, 2); i++) {
    const start = randomWorkday(addDays(M2_START, 1), addDays(lastDay < TODAY ? lastDay : TODAY, -2));
    const end = addDays(start, int(0, 1));
    const type = pick(["CL", "SL", "CL", "COMP"]);
    if (end < TODAY && end <= lastDay) addLeave(item, type, start, end, "approved", pick(LEAVE_REASONS[type]!));
  }
  if (chance(0.3)) { const d = randomWorkday(addDays(M2_START, 3), addDays(TODAY, -3)); addLeave(item, "CL", d, d, "approved", "Half day – personal errand", { days: 0.5 }); }
  if (!item.lastDay && chance(0.45)) {
    const start = randomWorkday(addDays(TODAY, 2), addDays(TODAY, 26));
    const type = pick(["CL", "EL", "SL"]);
    addLeave(item, type, start, addDays(start, int(0, 3)), "pending", pick(LEAVE_REASONS[type]!));
  }
  if (chance(0.2)) { const start = randomWorkday(addDays(M2_START, 5), addDays(TODAY, -5)); addLeave(item, "EL", start, addDays(start, 2), "rejected", pick(LEAVE_REASONS.EL!), { comment: pick(["Quarter-end closing – please reschedule", "Two team members already on leave that week", "Peak dispatch season, not possible"]) }); }
  if (chance(0.12)) { const start = randomWorkday(addDays(TODAY, -20), addDays(TODAY, 10)); addLeave(item, "CL", start, start, "cancelled", "Plan changed"); }
}
// specific edge cases
{ const start = randomWorkday(addDays(M1_START, 2), addDays(M1_START, 9)); addLeave(person("sunil"), "LOP", start, addDays(start, 1), "approved", "Personal emergency – leave balance exhausted"); }
{ const d = randomWorkday(addDays(M2_START, 5), addDays(M2_START, 20)); addLeave(person("ganesh"), "LOP", d, d, "approved", "Unplanned absence, informed late"); }
{ const start = addDays(M1_START, 4); addLeave(person("meera"), "MAT", start, `${YEAR}-12-31`, "approved", "Maternity leave as per policy"); }
addLeave(person("pooja"), "SL", TODAY, TODAY, "pending", "Not feeling well, will update by noon");
await insertMany(t.leaveRequests, leaveRows);
{
  const balanceRows: Array<typeof t.leaveBalances.$inferInsert> = [];
  for (const item of PEOPLE.filter((p) => p.userId)) {
    for (const type of LEAVE_TYPES.filter((lt) => !lt.status && (lt.code !== "MAT" || item.key === "meera"))) {
      const used = leaveRows.filter((r) => r.employeeId === item.profileId && r.leaveTypeId === leaveTypeIds[type.code] && r.status === "approved" && r.startDate.startsWith(String(YEAR))).reduce((sum, r) => sum + r.days, 0);
      balanceRows.push({ organizationId: orgId, employeeId: item.profileId, leaveTypeId: leaveTypeIds[type.code]!, year: YEAR, entitlementDays: item.key === "tejas" ? Math.round(type.days / 6) : type.days, usedDays: used, createdAt: at(`${YEAR}-01-01`, "09:00") });
    }
  }
  await insertMany(t.leaveBalances, balanceRows);
}

// ---------- 8. file assets for photos ----------
const fileRows: Array<typeof t.fileAssets.$inferInsert> = [];
const guardFor = (loc: LocKey) => (loc === "chakan" ? U("santosh") : U("ramesh"));
for (const item of PEOPLE) {
  fileRows.push({ id: item.photoId, organizationId: orgId, purpose: "attendance_photo", originalFilename: `selfie-${item.first.toLowerCase()}.png`, mimeType: "image/png", sizeBytes: int(18_000, 65_000), storageUrl: avatarUrl(`${item.first} ${item.last}`), uploadedBy: item.userId ?? guardFor(item.loc).id, createdAt: addTime(ORG_CREATED, 400) });
}

// ---------- 9. attendance (records for logins, guard-station adjustments for others) ----------
type RecordRow = typeof t.attendanceRecords.$inferInsert;
type AdjustmentRow = typeof t.attendanceAdjustments.$inferInsert;
const records: RecordRow[] = [];
const adjustments: AdjustmentRow[] = [];
const overtimeCandidates: Array<{ item: Person; date: string; minutes: number }> = [];
const SKIP_TODAY = new Set(["aditya", "pooja", "vikram", "kiran", "priya"]);
const FORGOT_CHECKOUT_DATE = (() => { let d = addDays(TODAY, -1); while (!isWorkday(d)) d = addDays(d, -1); return d; })();

function unpaidOverlap(shift: ShiftKey | null, date: string, start: Date, end: Date) {
  if (!shift) return 0;
  let minutes = 0;
  for (const brk of SHIFTS[shift].breaks.filter((b) => !b.paid)) {
    let bs = hm(brk.startTime); let be = hm(brk.endTime);
    if (SHIFTS[shift].crosses && bs < hm(SHIFTS[shift].start)) { bs += 1440; be += 1440; }
    const overlap = Math.min(end.getTime(), atMin(date, be).getTime()) - Math.max(start.getTime(), atMin(date, bs).getTime());
    if (overlap > 0) minutes += Math.floor(overlap / 60_000);
  }
  return minutes;
}
const punch = (item: Person, when: Date, verified: boolean): t.Punch => {
  const office = OFFICES[item.loc];
  const lat = Number((office.lat + (rand() - 0.5) * 0.0012).toFixed(6));
  const lng = Number((office.lng + (rand() - 0.5) * 0.0012).toFixed(6));
  return { at: when.toISOString(), latitude: lat, longitude: lng, gpsAccuracyM: int(4, 28), officeDistanceM: verified ? int(6, Math.round(office.radius * 0.7)) : null, locationVerification: verified ? "verified" : "not_enforced", photoAssetId: item.photoId };
};
const historyEntry = (before: t.AdjustmentSnapshot | null, after: t.AdjustmentSnapshot, actorId: string, when: Date): t.AdjustmentHistoryEntry => ({ before, after, actorId, at: when.toISOString() });

for (const item of PEOPLE) {
  const lastDay = item.lastDay ?? TODAY;
  const leaves = leaveDays.get(item.profileId) ?? new Map<string, number>();
  const otProne = ["WH", "SEC", "IT", "PKG", "ACC"].includes(item.dept ?? "");
  for (let date = item.joined > ATTENDANCE_START ? item.joined : ATTENDANCE_START; date <= lastDay; date = addDays(date, 1)) {
    if (!isWorkday(date)) continue;
    if (date === TODAY && SKIP_TODAY.has(item.key)) continue;
    const leaveUnits = leaves.get(date) ?? 0;
    if (leaveUnits >= 1) continue;
    const shiftKey = shiftFor(item, date) ?? "general";
    const shift = SHIFTS[shiftKey];
    const start = hm(shift.start);
    let end = hm(shift.end); if (shift.crosses) end += 1440;
    const roll = rand();
    const absent = roll < 0.045;
    if (absent) {
      if (date !== TODAY && chance(item.userId ? 0.25 : 0.5)) {
        const marked = at(addDays(date, 1), "10:30", int(0, 90));
        const after = { status: "absent" as const, checkInAt: null, checkOutAt: null, reason: pick(["Absent without intimation", "Did not report – phone switched off", "Absent – informed after shift"]) };
        const adjustedBy = item.userId ? U("rohan").id : guardFor(item.loc).id;
        adjustments.push({ organizationId: orgId, employeeId: item.userId ?? item.profileId, workforceEmployeeId: item.userId ? null : item.profileId, attendanceDate: date, status: "absent", reason: after.reason, adjustedBy: U("rohan").id, history: [historyEntry(null, { ...after }, adjustedBy, notFuture(marked))], createdAt: notFuture(marked), updatedAt: notFuture(marked) });
      }
      continue;
    }
    const halfDay = leaveUnits === 0.5 || roll < 0.075;
    const late = !halfDay && roll < 0.16;
    const grace = 10 + shift.flex;
    const inOffset = late ? int(grace + 6, grace + 70) : int(-22, Math.min(grace, 8));
    const checkInAt = atMin(date, start + inOffset);
    if (checkInAt > NOW) continue;
    const isOt = !halfDay && otProne && chance(0.09);
    const outMinute = halfDay ? start + inOffset + int(200, 235) : isOt ? end + int(70, 210) : end + int(-6, 38);
    const checkOutAt = atMin(date, outMinute);
    const open = checkOutAt > NOW || (item.key === "kiran" && date === FORGOT_CHECKOUT_DATE);
    if (isOt && !open) overtimeCandidates.push({ item, date, minutes: outMinute - end });
    const verified = date < M1_START;
    if (item.userId) {
      const unpaid = open ? 0 : unpaidOverlap(shiftKey, date, checkInAt, checkOutAt);
      const working = open ? null : Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000) - unpaid;
      const threshold = Math.min(240, Math.floor((end - start) / 2));
      records.push({
        id: randomUUID(), organizationId: orgId, employeeId: item.userId, attendanceDate: date, officeLocationId: locIds[item.loc], shiftId: shiftIds[shiftKey], shiftName: shift.name,
        checkIn: punch(item, checkInAt, verified), checkOut: open ? null : punch(item, checkOutAt, verified), status: open ? "checked_in" : "completed",
        lateArrival: inOffset > grace, totalWorkingMinutes: working, unpaidBreakMinutes: unpaid, halfDay: working !== null && working < threshold,
        createdAt: checkInAt, updatedAt: open ? checkInAt : checkOutAt,
      });
    } else {
      const guard = guardFor(item.loc);
      const location = (when: Date): t.PunchLocation => { const p = punch(item, when, verified); return { latitude: p.latitude!, longitude: p.longitude!, gpsAccuracyM: p.gpsAccuracyM!, ...(verified ? { officeDistanceM: p.officeDistanceM! } : {}), locationVerification: p.locationVerification }; };
      const inSnap = { status: "present" as const, checkInAt: checkInAt.toISOString(), checkOutAt: null, reason: "Mobile guard check-in" };
      const history = [historyEntry(null, inSnap, guard.id, checkInAt)];
      const status = halfDay ? ("half_day" as const) : ("present" as const);
      if (!open) history.push(historyEntry(inSnap, { status: "present", checkInAt: checkInAt.toISOString(), checkOutAt: checkOutAt.toISOString(), reason: "Mobile guard check-out" }, guard.id, checkOutAt));
      if (halfDay && !open) history.push(historyEntry({ status: "present", checkInAt: checkInAt.toISOString(), checkOutAt: checkOutAt.toISOString(), reason: "Mobile guard check-out" }, { status: "half_day", checkInAt: checkInAt.toISOString(), checkOutAt: checkOutAt.toISOString(), reason: "Left early – marked half day by supervisor" }, U("rohan").id, addTime(checkOutAt, 45)));
      adjustments.push({
        organizationId: orgId, employeeId: item.profileId, workforceEmployeeId: item.profileId, attendanceDate: date, officeLocationId: locIds[item.loc],
        checkInLocation: location(checkInAt), checkOutLocation: open ? null : location(checkOutAt), status, checkInAt, checkOutAt: open ? null : checkOutAt,
        photoAssetIds: [item.photoId], reason: halfDay && !open ? "Left early – marked half day by supervisor" : open ? "Mobile guard check-in" : "Mobile guard check-out",
        adjustedBy: halfDay && !open ? U("rohan").id : guard.id, history, createdAt: checkInAt, updatedAt: open ? checkInAt : checkOutAt,
      });
    }
  }
}
// Admin overrides for login users: "biometric offline" days marked present by HR.
for (const key of ["sneha", "deepak", "asha", "farhan"]) {
  const item = person(key);
  const date = randomWorkday(addDays(M1_START, 1), addDays(TODAY, -4));
  if ((leaveDays.get(item.profileId) ?? new Map()).has(date) || records.some((r) => r.employeeId === item.userId && r.attendanceDate === date) || adjustments.some((a) => a.employeeId === item.userId && a.attendanceDate === date)) continue;
  const inAt = at(date, "09:28"); const outAt = at(date, "18:35");
  const when = at(addDays(date, 1), "11:15");
  const after = { status: "present" as const, checkInAt: inAt.toISOString(), checkOutAt: outAt.toISOString(), reason: "Biometric/app outage – marked present by HR" };
  adjustments.push({ organizationId: orgId, employeeId: item.userId!, attendanceDate: date, status: "present", checkInAt: inAt, checkOutAt: outAt, reason: after.reason, adjustedBy: U("rohan").id, history: [historyEntry(null, after, U("rohan").id, when)], createdAt: when, updatedAt: when });
}
await insertMany(t.fileAssets, fileRows);
await insertMany(t.attendanceRecords, records);
await insertMany(t.attendanceAdjustments, adjustments);
for (const row of adjustments.filter((a) => a.status === "absent" || a.reason.startsWith("Biometric"))) audit(U("rohan"), "attendance.manually_adjusted", "attendance_adjustment", row.employeeId, row.createdAt as Date, { after: { status: row.status, attendanceDate: row.attendanceDate }, reason: row.reason });

// ---------- 10. attendance corrections ----------
{
  const correctionRows: Array<typeof t.attendanceCorrections.$inferInsert> = [];
  const usedRecords = new Set<string>();
  const lateRecords = records.filter((r) => r.lateArrival && r.status === "completed" && r.attendanceDate >= addDays(TODAY, -35) && r.attendanceDate < TODAY);
  const plan: Array<"pending" | "approved" | "rejected"> = ["pending", "pending", "pending", "approved", "approved", "approved", "rejected", "rejected"];
  for (const status of plan) {
    const record = lateRecords.find((r) => !usedRecords.has(r.id!) && !correctionRows.some((c) => c.employeeId === r.employeeId && c.status === "pending"));
    if (!record) break;
    usedRecords.add(record.id!);
    const shiftStart = hm(SHIFTS[(PEOPLE.find((p) => p.userId === record.employeeId) && shiftFor(PEOPLE.find((p) => p.userId === record.employeeId)!, record.attendanceDate)) ?? "general"].start);
    const requested = atMin(record.attendanceDate, shiftStart - int(2, 12));
    const created = at(record.attendanceDate, "19:30", int(0, 150));
    const reviewer = U("rohan");
    const reviewedAt = status === "pending" ? null : notFuture(at(addDays(record.attendanceDate, 1), "11:00", int(0, 240)));
    const id = randomUUID();
    const reason = pick(["Face scan failed at the gate, I reached on time", "App was stuck on 'locating', punched after it recovered", "Was at a customer site first – manager informed", "Phone battery died, punched once charged"]);
    const before = record.checkIn!.at;
    correctionRows.push({ id, organizationId: orgId, attendanceRecordId: record.id!, employeeId: record.employeeId, requestedCheckInAt: requested, reason, status, reviewedBy: reviewedAt ? reviewer.id : null, reviewedAt, reviewComment: status === "rejected" ? "CCTV shows arrival at the recorded time" : status === "approved" ? "Verified with supervisor" : "", appliedChange: status === "approved" ? { fields: { checkInAt: { before, after: requested.toISOString() } }, approvedBy: reviewer.id, reason } : null, createdAt: created, updatedAt: reviewedAt ?? created });
    if (status === "approved") {
      record.checkIn = { ...record.checkIn!, at: requested.toISOString() };
      const checkOut = new Date(record.checkOut!.at);
      record.totalWorkingMinutes = Math.floor((checkOut.getTime() - requested.getTime()) / 60_000) - (record.unpaidBreakMinutes ?? 0);
      record.halfDay = false;
      await db.update(t.attendanceRecords).set({ checkIn: record.checkIn, totalWorkingMinutes: record.totalWorkingMinutes, halfDay: false }).where(eq(t.attendanceRecords.id, record.id!));
    }
    audit({ id: record.employeeId, role: "employee" }, "attendance.correction_requested", "attendance_correction", id, created, { after: { attendanceRecordId: record.id, reason } });
    if (reviewedAt) audit(reviewer, `attendance.correction_${status}`, "attendance_correction", id, reviewedAt);
  }
  // Kiran forgot to check out yesterday: an open shift with a pending correction for the missing check-out.
  const open = records.find((r) => r.employeeId === person("kiran").userId && r.attendanceDate === FORGOT_CHECKOUT_DATE);
  if (open) {
    correctionRows.push({ organizationId: orgId, attendanceRecordId: open.id!, employeeId: open.employeeId, requestedCheckOutAt: at(FORGOT_CHECKOUT_DATE, "18:42"), reason: "Forgot to check out – left at 6:40 pm after the server maintenance", status: "pending", createdAt: notFuture(at(TODAY, "09:05")) });
  }
  await insertMany(t.attendanceCorrections, correctionRows);
  for (const row of correctionRows.filter((c) => c.status === "approved")) await db.update(t.attendanceRecords).set({ correctionId: row.id! }).where(eq(t.attendanceRecords.id, row.attendanceRecordId));
}

// ---------- 11. overtime ----------
const otStd = randomUUID(); const otHol = randomUUID(); const otOld = randomUUID();
const OT_POLICIES = [
  { id: otStd, name: "Standard Overtime (1.5x)", calculation: "multiplier" as const, multiplierBasisPoints: 15000, hourlyRateMinor: rupees(150), minimumMinutes: 30, roundingMinutes: 15, maximumMinutesPerDay: 240, effectiveFrom: COMP_FROM, effectiveTo: null, status: "active" as const },
  { id: otHol, name: "Sunday & Holiday Duty", calculation: "fixed_hourly" as const, multiplierBasisPoints: 10000, hourlyRateMinor: rupees(300), minimumMinutes: 60, roundingMinutes: 30, maximumMinutesPerDay: 480, effectiveFrom: COMP_FROM, effectiveTo: null, status: "active" as const },
  { id: otOld, name: "Legacy Overtime (2x)", calculation: "multiplier" as const, multiplierBasisPoints: 20000, hourlyRateMinor: rupees(120), minimumMinutes: 60, roundingMinutes: 30, maximumMinutesPerDay: 180, effectiveFrom: "2025-04-01", effectiveTo: "2026-03-31", status: "inactive" as const },
];
await insertMany(t.overtimePolicies, OT_POLICIES.map((item) => ({ ...item, organizationId: orgId, createdAt: addTime(ORG_CREATED, 500) })));
const otRows: Array<typeof t.overtimeEntries.$inferInsert> = [];
function addOvertime(item: Person, date: string, actualMinutes: number, policy: (typeof OT_POLICIES)[number], status: "pending" | "approved" | "rejected", reason: string) {
  const rounded = Math.floor(actualMinutes / policy.roundingMinutes) * policy.roundingMinutes;
  const calculatedMinutes = Math.min(rounded >= policy.minimumMinutes ? rounded : 0, policy.maximumMinutesPerDay);
  const hourly = policy.calculation === "multiplier" && item.pay === "hourly" ? rupees(220) : policy.hourlyRateMinor;
  const approvedMinutes = status === "approved" ? calculatedMinutes : 0;
  const payable = status === "approved" ? calculateOvertimeAmountMinor(approvedMinutes, hourly, policy.calculation === "multiplier" ? policy.multiplierBasisPoints : 10000) : 0;
  const created = notFuture(at(addDays(date, isWorkday(date) ? 0 : 1), "20:30", int(0, 600)));
  const reviewedAt = status === "pending" ? null : notFuture(addTime(created, int(600, 3000)));
  const reviewer = ["WH", "PKG", "SEC", "HR"].includes(item.dept ?? "") ? U("rohan") : adminActor;
  const id = randomUUID();
  otRows.push({ id, organizationId: orgId, employeeId: item.profileId, workDate: date, actualMinutes, calculatedMinutes, approvedMinutes, policyId: policy.id, policySnapshot: { name: policy.name, calculation: policy.calculation, multiplierBasisPoints: policy.multiplierBasisPoints, hourlyRateMinor: hourly, roundingMinutes: policy.roundingMinutes, maximumMinutesPerDay: policy.maximumMinutesPerDay, capturedAt: created.toISOString() }, hourlyRateMinor: hourly, payableAmountMinor: payable, status, reason, createdBy: item.userId ?? U("rohan").id, reviewedBy: reviewedAt ? reviewer.id : null, reviewedAt, createdAt: created, updatedAt: reviewedAt ?? created });
  audit({ id: item.userId ?? U("rohan").id, role: item.role ?? "sub_admin" }, "overtime.entry_created", "overtime_entry", id, created, { after: { workDate: date, actualMinutes, calculatedMinutes } });
  if (reviewedAt) audit(reviewer, `overtime.entry_${status}`, "overtime_entry", id, reviewedAt, { after: { status, approvedMinutes, payableAmountMinor: payable } });
}
const OT_REASONS = ["Late truck arrival – unloading finished after shift", "Month-end dispatch backlog", "Server migration support after office hours", "Stock audit preparation", "Relieving guard did not report", "Festive season order rush", "Year-end ledger reconciliation"];
for (const candidate of overtimeCandidates) {
  const status = candidate.date < M1_START ? "approved" : candidate.date < M0_START ? (chance(0.85) ? "approved" : "rejected") : candidate.date >= addDays(TODAY, -6) ? "pending" : chance(0.6) ? "approved" : "pending";
  addOvertime(candidate.item, candidate.date, candidate.minutes, OT_POLICIES[0]!, status, pick(OT_REASONS));
}
// Sunday duty for the warehouse during the festive rush.
for (const key of ["sachin", "raju", "mahesh", "imran", "shankar"]) {
  let sunday = addDays(M1_START, (7 - weekday(M1_START)) % 7);
  for (let i = 0; i < 2; i++, sunday = addDays(sunday, 7)) if (sunday < TODAY) addOvertime(person(key), sunday, int(300, 480), OT_POLICIES[1]!, "approved", "Sunday loading for festive dispatch");
}
// Edge cases: below the minimum (0 payable minutes), and above the daily cap.
addOvertime(person("kiran"), randomWorkday(addDays(TODAY, -8), addDays(TODAY, -2)), 22, OT_POLICIES[0]!, "pending", "Stayed back to restart the billing server");
addOvertime(person("mahesh"), randomWorkday(addDays(TODAY, -10), addDays(TODAY, -3)), 315, OT_POLICIES[0]!, "pending", "Container de-stuffing ran till late night");
addOvertime(person("riya"), randomWorkday(addDays(M1_START, 3), addDays(M1_START, 20)), 120, OT_POLICIES[0]!, "approved", "GST return filing support");
await insertMany(t.overtimeEntries, otRows);

// ---------- 12. daily earnings ----------
const earningRows: Array<typeof t.dailyEarnings.$inferInsert> = [];
function addEarning(item: Person, date: string, source: (typeof t.dailyEarnings.$inferInsert)["source"], description: string, quantityThousandths: number, rateMinor: number, status?: "pending" | "approved" | "rejected", adjustmentOf: string | null = null) {
  const resolved = status ?? (date < M0_START ? "approved" : date >= addDays(TODAY, -4) ? "pending" : chance(0.75) ? "approved" : "pending");
  const id = randomUUID();
  const created = notFuture(at(date, "18:45", int(0, 200)));
  earningRows.push({ id, organizationId: orgId, employeeId: item.profileId, earningDate: date, source, description, quantityThousandths, rateMinor, amountMinor: calculateDailyAmountMinor(quantityThousandths, rateMinor), currency: "INR", status: resolved, createdBy: U(item.dept === "PKG" || item.dept === "WH" ? "mahesh" : "rohan").id, adjustmentOf, createdAt: created, updatedAt: created });
  audit(U("mahesh"), "payroll.daily_earning_created", "daily_earning", id, created, { after: { source, description, quantityThousandths, rateMinor } });
  return id;
}
{
  const presentDays = new Map<string, string[]>();
  for (const row of adjustments) if (row.workforceEmployeeId && row.status !== "absent" && row.checkOutAt) presentDays.set(row.workforceEmployeeId, [...(presentDays.get(row.workforceEmployeeId) ?? []), row.attendanceDate]);
  for (const item of PEOPLE.filter((p) => p.pay === "piece")) {
    const days = presentDays.get(item.profileId) ?? [];
    let previous: string | null = null;
    for (const date of days) {
      const cartons = int(140, 320) + (rand() < 0.3 ? 0.5 : 0);
      previous = addEarning(item, date, "piece_rate", `Cartons packed – ${cartons}`, Math.round(cartons * 1000), 450);
    }
    if (previous && chance(0.8)) addEarning(item, days.at(-3) ?? days.at(-1)!, "adjustment", "Adjustment: 12 cartons missed in the line count", 12_000, 450, "approved", previous);
  }
  for (const item of PEOPLE.filter((p) => p.pay === "daily" || p.pay === "piece")) {
    const days = presentDays.get(item.profileId) ?? [];
    for (const date of days.filter(() => chance(0.07))) addEarning(item, date, "task", "Extra truck unloading trip", int(1, 3) * 1000, rupees(350));
    for (const date of days.filter(() => chance(0.03))) addEarning(item, date, "manual", "Night loading allowance", 1000, rupees(250));
  }
  const bonusDate = addDays(M0_START, 6);
  if (bonusDate < TODAY) for (const item of PEOPLE.filter((p) => (p.pay === "daily" || p.pay === "piece" || p.pay === "guard") && (!p.lastDay || p.lastDay >= bonusDate))) addEarning(item, bonusDate, "bonus", "Diwali bonus", 1000, rupees(item.pay === "guard" ? 3000 : 2500), "approved");
  const auditDate = addDays(M1_START, (7 - weekday(M1_START)) % 7 + 7);
  for (const key of ["sachin", "raju", "dnyaneshwar"]) addEarning(person(key), auditDate, "attendance", "Sunday stock-audit attendance", 1000, rupees(700), "approved");
  // A duplicate entry that was rejected, and one still awaiting approval.
  addEarning(person("lata"), randomWorkday(addDays(M1_START, 2), addDays(M1_START, 20)), "piece_rate", "Cartons packed – 210 (duplicate entry)", 210_000, 450, "rejected");
  addEarning(person("sachin"), randomWorkday(addDays(TODAY, -3), TODAY), "task", "Return goods sorting – 2 trips", 2000, rupees(350), "pending");
  addEarning(person("riya"), randomWorkday(addDays(M0_START, 1), addDays(TODAY, -1)), "manual", "Weekend data-entry support (2.5 hrs)", 2500, rupees(220));
}
await insertMany(t.dailyEarnings, earningRows);

// ---------- 13. shift swaps ----------
{
  const swap = (requester: string, target: string, date: string, status: "pending" | "approved" | "rejected" | "cancelled", reason: string, comment = "") => {
    const r = person(requester); const tg = person(target);
    const created = notFuture(at(addDays(date, -int(2, 6)), "12:00", int(0, 300)));
    const reviewedAt = status === "approved" || status === "rejected" ? notFuture(addTime(created, int(120, 1800))) : null;
    return { organizationId: orgId, requesterEmployeeId: r.profileId, targetEmployeeId: tg.profileId, requesterShiftId: shiftIds[shiftFor(r, date)!], targetShiftId: shiftIds[shiftFor(tg, date)!], shiftDate: date, reason, status, reviewedBy: reviewedAt ? U("rohan").id : null, reviewedAt, reviewComment: comment, createdAt: created, updatedAt: reviewedAt ?? created };
  };
  await insertMany(t.shiftSwaps, [
    swap("santosh", "balu", randomWorkday(addDays(M1_START, 15), addDays(M1_START, 25)), "approved", "Family function in the evening", "Approved – both guards confirmed"),
    swap("balu", "shankar", randomWorkday(addDays(M2_START, 10), addDays(M2_START, 20)), "rejected", "Need the day shift for a medical appointment", "Shankar is already on double duty that week"),
    swap("deepak", "imran", randomWorkday(addDays(TODAY, -12), addDays(TODAY, -4)), "cancelled", "Vehicle servicing appointment"),
    swap("ramesh", "santosh", randomWorkday(addDays(TODAY, 2), addDays(TODAY, 6)), "pending", "Parent-teacher meeting in the afternoon"),
    swap("raju", "dnyaneshwar", randomWorkday(addDays(TODAY, 3), addDays(TODAY, 9)), "pending", "Bank loan appointment in the morning"),
  ]);
}

// ---------- 14. customers ----------
type Profile = "good" | "slow" | "defaulter" | "disputer" | "new" | "archived" | "none";
type Size = "small" | "mid" | "large";
const CITIES: Record<string, { state: string; code: string; pin: string; lat: number; lng: number }> = {
  Pune: { state: "Maharashtra", code: "27", pin: "4110", lat: 18.5204, lng: 73.8567 }, Mumbai: { state: "Maharashtra", code: "27", pin: "4000", lat: 19.076, lng: 72.8777 },
  Nashik: { state: "Maharashtra", code: "27", pin: "4220", lat: 19.9975, lng: 73.7898 }, Aurangabad: { state: "Maharashtra", code: "27", pin: "4310", lat: 19.8762, lng: 75.3433 },
  Kolhapur: { state: "Maharashtra", code: "27", pin: "4160", lat: 16.705, lng: 74.2433 }, Satara: { state: "Maharashtra", code: "27", pin: "4150", lat: 17.6805, lng: 74.0183 },
  Ahmednagar: { state: "Maharashtra", code: "27", pin: "4140", lat: 19.0948, lng: 74.748 }, Solapur: { state: "Maharashtra", code: "27", pin: "4130", lat: 17.6599, lng: 75.9064 },
  Nagpur: { state: "Maharashtra", code: "27", pin: "4400", lat: 21.1458, lng: 79.0882 }, Panaji: { state: "Goa", code: "30", pin: "4030", lat: 15.4909, lng: 73.8278 },
  Hubballi: { state: "Karnataka", code: "29", pin: "5800", lat: 15.3647, lng: 75.124 }, Thane: { state: "Maharashtra", code: "27", pin: "4006", lat: 19.2183, lng: 72.9781 },
};
const CUSTOMERS: Array<{ name: string; company: string; city: string; profile: Profile; size: Size; credit: number; limit?: number; gst?: boolean; notes?: string; noContact?: boolean; noPhone?: boolean }> = [
  { name: "Shree Ganesh Traders", company: "Shree Ganesh Traders", city: "Pune", profile: "good", size: "mid", credit: 30, limit: 1500000, notes: "Pays on the 5th of every month by NEFT." },
  { name: "Om Sai Enterprises", company: "Om Sai Enterprises LLP", city: "Pune", profile: "slow", size: "mid", credit: 30, limit: 1000000, notes: "Accounts head Mr. Shah is available only after 3 pm." },
  { name: "Laxmi Narayan Agencies", company: "Laxmi Narayan Agencies", city: "Nashik", profile: "good", size: "mid", credit: 45 },
  { name: "Patil Hardware & Paints", company: "Patil Hardware and Paints Pvt Ltd", city: "Satara", profile: "slow", size: "small", credit: 30, limit: 300000 },
  { name: "Mahalaxmi Supermarket", company: "Mahalaxmi Retail Pvt Ltd", city: "Kolhapur", profile: "good", size: "large", credit: 45, limit: 4000000 },
  { name: "Royal Kirana Stores", company: "Royal Kirana Stores", city: "Pune", profile: "defaulter", size: "small", credit: 15, gst: false, noContact: true, notes: "Cash-and-carry customer. No email on record – collect by visit only." },
  { name: "Balaji Wholesale Mart", company: "Balaji Wholesale Mart", city: "Solapur", profile: "good", size: "mid", credit: 30, limit: 1200000 },
  { name: "Kothari Distributors", company: "Kothari Distributors Pvt Ltd", city: "Mumbai", profile: "slow", size: "large", credit: 60, limit: 5000000, notes: "Large account – escalate to Neha for anything above ₹5 lakh." },
  { name: "Sahyadri Agro Products", company: "Sahyadri Agro Products Pvt Ltd", city: "Satara", profile: "disputer", size: "mid", credit: 30, limit: 800000, notes: "Frequently disputes short supply. Get delivery challan signed with remarks." },
  { name: "Swami Samarth Medicals", company: "Swami Samarth Medicals", city: "Pune", profile: "good", size: "small", credit: 15 },
  { name: "New Bharat Electricals", company: "New Bharat Electricals", city: "Aurangabad", profile: "defaulter", size: "mid", credit: 30, limit: 500000, notes: "Credit hold – no new dispatch until overdue is cleared." },
  { name: "Deccan Fresh Foods", company: "Deccan Fresh Foods Pvt Ltd", city: "Pune", profile: "slow", size: "large", credit: 45, limit: 3000000 },
  { name: "Jai Bhavani Provision", company: "Jai Bhavani Provision Stores", city: "Ahmednagar", profile: "good", size: "small", credit: 15, gst: false },
  { name: "Annapurna Caterers", company: "Annapurna Caterers & Events", city: "Pune", profile: "slow", size: "small", credit: 30 },
  { name: "Siddhivinayak Pharma Distributors", company: "Siddhivinayak Pharma Distributors Pvt Ltd", city: "Thane", profile: "good", size: "large", credit: 60, limit: 6000000 },
  { name: "Konkan Coastal Retail", company: "Konkan Coastal Retail Pvt Ltd", city: "Panaji", profile: "disputer", size: "mid", credit: 45, limit: 1000000 },
  { name: "Metro Cash Point", company: "Metro Cash Point", city: "Nagpur", profile: "good", size: "mid", credit: 30 },
  { name: "Rajmudra Hotels", company: "Rajmudra Hotels Pvt Ltd", city: "Kolhapur", profile: "slow", size: "large", credit: 45, limit: 2500000, notes: "Payments approved only in the monthly board meeting (last Friday)." },
  { name: "Green Leaf Organics", company: "Green Leaf Organics Pvt Ltd", city: "Pune", profile: "new", size: "mid", credit: 30, limit: 600000, notes: "New account onboarded this month." },
  { name: "Vardhaman Steel Centre", company: "Vardhaman Steel Centre", city: "Aurangabad", profile: "defaulter", size: "large", credit: 30, limit: 1500000 },
  { name: "Aurangabad Auto Spares", company: "Aurangabad Auto Spares", city: "Aurangabad", profile: "slow", size: "small", credit: 30 },
  { name: "Nashik Valley Foods", company: "Nashik Valley Foods & Beverages Pvt Ltd", city: "Nashik", profile: "good", size: "large", credit: 45, limit: 3500000 },
  { name: "Shivshakti General Stores", company: "Shivshakti General Stores", city: "Pune", profile: "good", size: "small", credit: 15, gst: false },
  { name: "Ganga Jamuna Textiles", company: "Ganga Jamuna Textiles", city: "Solapur", profile: "disputer", size: "mid", credit: 30 },
  { name: "Sunrise Bakery & Confectionery", company: "Sunrise Bakers", city: "Pune", profile: "good", size: "small", credit: 15 },
  { name: "Pune Office Supplies Co.", company: "Pune Office Supplies Company", city: "Pune", profile: "good", size: "small", credit: 30, notes: "Always pays before the due date." },
  { name: "Kolhapur Sugar Traders", company: "Kolhapur Sugar Traders", city: "Kolhapur", profile: "slow", size: "mid", credit: 45 },
  { name: "Sai Krupa Departmental Store", company: "Sai Krupa Departmental Store", city: "Ahmednagar", profile: "defaulter", size: "small", credit: 30, noPhone: true, notes: "Shop shut since last month. Owner not reachable." },
  { name: "Mangalmurti Medical Agencies", company: "Mangalmurti Medical Agencies", city: "Hubballi", profile: "good", size: "mid", credit: 30 },
  { name: "Nagpur Orange Exports", company: "Nagpur Orange Exports Pvt Ltd", city: "Nagpur", profile: "new", size: "large", credit: 45 },
  { name: "Hotel Shreyas Residency", company: "Shreyas Hospitality Pvt Ltd", city: "Pune", profile: "slow", size: "mid", credit: 30 },
  { name: "Satara Dairy Cooperative", company: "Satara Taluka Dairy Co-operative Society Ltd", city: "Satara", profile: "good", size: "large", credit: 30 },
  { name: "Ashirwad Kitchenware", company: "Ashirwad Kitchenware", city: "Pune", profile: "archived", size: "small", credit: 30, notes: "Account closed – business discontinued. All dues cleared." },
  { name: "Zenith Infra Projects", company: "Zenith Infra Projects Pvt Ltd", city: "Mumbai", profile: "archived", size: "large", credit: 60, notes: "Duplicate of Zenith Infra (Mumbai) – archived." },
  { name: "Ekdant Electronics", company: "Ekdant Electronics", city: "Pune", profile: "none", size: "small", credit: 30, notes: "Prospect – first order expected next month." },
  { name: "Sri Venkateshwara Wholesale Grocery & Household Essentials Distributors", company: "Sri Venkateshwara Wholesale Grocery and Household Essentials Distributors Private Limited", city: "Hubballi", profile: "slow", size: "mid", credit: 30 },
];
const FIRST_NAMES = ["Rajesh", "Sanjay", "Mukesh", "Anand", "Prashant", "Nitin", "Vijay", "Suresh", "Manoj", "Yogesh", "Kavita", "Sunanda", "Rupali", "Smita", "Varsha", "Harish", "Jayant", "Dilip", "Shrikant", "Ajay", "Bhavesh", "Hitesh", "Mohan", "Rekha", "Nilesh", "Abhijit", "Swapnil", "Gauri", "Pallavi", "Tushar"];
const LAST_NAMES = ["Shah", "Mehta", "Agarwal", "Kulkarni", "Deshmukh", "Pawar", "Jain", "Gupta", "Bhosale", "Naik", "Kamat", "Rao", "Shetty", "Patil", "Joshi", "Thakur", "Desai", "Sawant", "Kothari", "Lunawat"];
const slug = (value: string) => value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").slice(0, 24);
const mobile = () => `+91 ${pick(["98", "97", "99", "94", "93", "88", "77", "70", "80"])}${digits(3)} ${digits(5)}`;
type Cust = (typeof CUSTOMERS)[number] & { id: string; contacts: t.CustomerContact[]; createdAt: Date; billing: t.Address; gstin: string | null; cycleDay: number };
const customers: Cust[] = CUSTOMERS.map((def, index) => {
  const city = CITIES[def.city]!;
  const contactCount = def.noContact ? 0 : int(1, 3);
  const contacts: t.CustomerContact[] = Array.from({ length: contactCount }, (_, i) => {
    const first = pick(FIRST_NAMES); const last = pick(LAST_NAMES);
    return { _id: randomUUID(), name: `${first} ${last}`, designation: ["Owner", "Accounts Manager", "Purchase Head"][i]!, phone: mobile(), email: `${first.toLowerCase()}.${last.toLowerCase()}@${slug(def.name)}.test`, isPrimary: i === 0 };
  });
  const billing: t.Address = { line1: `${int(1, 250)}, ${pick(["Market Yard", "MIDC Industrial Area", "Station Road", "Main Bazaar", "Shivaji Nagar", "Laxmi Road", "Ring Road", "Gandhi Chowk", "College Road"])}`, line2: chance(0.5) ? pick(["Near Bus Stand", "Opp. SBI Bank", "Behind Petrol Pump", "Ground Floor", "Shop No. 4"]) : "", city: def.city, state: city.state, postalCode: `${city.pin}${digits(2)}`, country: "India" };
  return {
    ...def, id: randomUUID(), contacts, billing, cycleDay: pick([5, 10, 20, 25]),
    gstin: def.gst === false ? null : `${city.code}${letters(5)}${digits(4)}${letters(1)}1Z${pick([...letters(1), String(int(1, 9))])}`,
    createdAt: def.profile === "new" ? at(addDays(TODAY, -int(18, 26)), "11:00") : addTime(ORG_CREATED, 600 + index * 37),
  };
});
await insertMany(t.customers, customers.map((c) => ({
  id: c.id, organizationId: orgId, displayName: c.name, companyName: c.company, gstin: c.gstin,
  email: c.noContact ? "" : `accounts@${slug(c.name)}.test`, phone: c.noPhone ? "" : mobile(), contacts: c.contacts, billingAddress: c.billing,
  businessAddress: chance(0.35) ? { ...c.billing, line1: `Godown ${int(1, 30)}, ${pick(["Transport Nagar", "APMC Market", "Industrial Estate"])}`, line2: "" } : t.EMPTY_ADDRESS,
  defaultCreditDays: c.credit, creditLimitMinor: c.limit ? rupees(c.limit) : null, notes: c.notes ?? "",
  status: c.profile === "archived" ? ("archived" as const) : ("active" as const), createdBy: pick([U("priya").id, U("sameer").id, U("neha").id]), updatedBy: U("priya").id, createdAt: c.createdAt, updatedAt: c.createdAt,
})));
for (const c of customers) audit(U("priya"), "customer.created", "customer", c.id, c.createdAt, { after: { displayName: c.name } });
for (const c of customers.filter((x) => x.profile === "archived")) audit(U("neha"), "customer.archived", "customer", c.id, at(addDays(TODAY, -int(20, 60)), "15:00"), { reason: c.notes });

// ---------- 15. invoices ----------
type Inv = { id: string; c: Cust; number: string; date: string; due: string; creditDays: number | null; term: "credit_days" | "explicit_date"; amount: number; status: "draft" | "issued" | "cancelled"; issuedAt: Date | null; createdAt: Date; by: { id: string; role: string }; cancelAt?: string; cancelReason?: string; ack: "not_shared" | "shared" | "acknowledged" | "rejected" | "disputed"; notes: string; outstanding: number };
const invoicesList: Inv[] = [];
const AMOUNTS: Record<Size, [number, number]> = { small: [6000, 65000], mid: [35000, 260000], large: [150000, 950000] };
const HISTORY_START = addDays(TODAY, -182);
function amountFor(c: Cust) {
  const [min, max] = AMOUNTS[c.size];
  const base = min + rand() * (max - min);
  return chance(0.35) ? rupees(Math.round(base)) + int(1, 99) : rupees(Math.round(base / 50) * 50);
}
const accountsUsers = [U("priya"), U("sameer"), U("neha")];
function addInvoice(c: Cust, date: string, overrides: Partial<Inv> = {}) {
  const term = chance(0.12) ? "explicit_date" : "credit_days";
  const due = term === "explicit_date" ? addDays(date, int(10, 75)) : addDays(date, c.credit);
  const by = c.city === "Aurangabad" ? U("sameer") : pick(accountsUsers);
  const createdAt = at(date, "10:15", int(0, 300));
  const inv: Inv = { id: randomUUID(), c, number: "", date, due, creditDays: term === "credit_days" ? c.credit : null, term, amount: amountFor(c), status: "issued", issuedAt: notFuture(addTime(createdAt, int(10, 1200))), createdAt: notFuture(createdAt), by, ack: "not_shared", notes: chance(0.15) ? pick(["Against PO dated last week", "Includes freight charges", "Scheme discount 2% already applied", "Rate as per annual contract", "Part delivery – balance next week"]) : "", outstanding: 0, ...overrides };
  invoicesList.push(inv);
  return inv;
}
for (const c of customers) {
  if (c.profile === "none") continue;
  if (c.profile === "archived") {
    if (c.name.startsWith("Ashirwad")) for (const back of [210, 185, 160]) addInvoice(c, addDays(TODAY, -back));
    continue;
  }
  const start = c.profile === "new" ? istDate(c.createdAt) : HISTORY_START;
  const perMonth: [number, number] = c.profile === "good" ? [1, 3] : c.profile === "defaulter" ? [0, 2] : [1, 2];
  for (let month = start; month <= TODAY; month = addDays(month, 30)) {
    for (let i = 0; i < int(...perMonth); i++) {
      const date = addDays(month, int(0, 29));
      if (date <= TODAY && date >= start) addInvoice(c, date);
    }
  }
  if (c.profile === "defaulter") for (let i = 0; i < int(1, 2); i++) addInvoice(c, addDays(TODAY, -int(200, 235)));
}
// Explicit edge cases on the dashboard: due today, due this week, tiny and very large amounts.
{
  const good = customers.filter((c) => c.profile === "good");
  addInvoice(pick(good), addDays(TODAY, -30), { term: "explicit_date", creditDays: null, due: TODAY, notes: "Due today – reminder sent" });
  addInvoice(customers.find((c) => c.name === "Kothari Distributors")!, addDays(TODAY, -40), { term: "explicit_date", creditDays: null, due: TODAY, amount: rupees(487500) });
  for (const offset of [1, 3, 5, 7]) addInvoice(pick(good), addDays(TODAY, offset - 30), { term: "explicit_date", creditDays: null, due: addDays(TODAY, offset) });
  addInvoice(customers.find((c) => c.name === "Swami Samarth Medicals")!, addDays(TODAY, -9), { amount: rupees(1180), notes: "Sample carton – minimum value invoice" });
  addInvoice(customers.find((c) => c.name === "Siddhivinayak Pharma Distributors")!, addDays(TODAY, -52), { amount: rupees(4875000), notes: "Annual stock-up order – 3 truckloads" });
}
// Drafts (not yet issued) and cancellations.
for (const c of [customers[0]!, customers[4]!, customers[11]!, customers[18]!, customers[21]!, customers[6]!]) addInvoice(c, addDays(TODAY, -int(0, 6)), { status: "draft", issuedAt: null });
addInvoice(customers[2]!, addDays(TODAY, -38), { status: "draft", issuedAt: null, notes: "Waiting for revised PO from customer" });
invoicesList.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime());
{
  const seq = new Map<string, number>();
  for (const inv of invoicesList) {
    const fy = fiscalYear(inv.date); const next = (seq.get(fy) ?? 0) + 1; seq.set(fy, next);
    inv.number = `VDX/${fy}/${String(next).padStart(4, "0")}`;
  }
  const cancelPool = invoicesList.filter((inv) => inv.status === "issued" && inv.date < addDays(TODAY, -10) && inv.c.profile !== "archived");
  const reasons = ["Duplicate invoice raised for the same dispatch", "Wrong rate applied – reissued with corrected rate", "Order cancelled by customer before delivery", "Billed to wrong party – reissued", "GSTIN mismatch – reissued"];
  for (const reason of reasons) {
    const inv = cancelPool.splice(int(0, cancelPool.length - 1), 1)[0];
    if (!inv) break;
    inv.cancelAt = addDays(inv.date, int(1, 8));
    inv.cancelReason = reason;
  }
}

// ---------- 16. payments ----------
type Alloc = { invoiceId: string; amount: number };
type Pay = { id: string; c: Cust; date: string; mode: "bank_transfer" | "upi" | "cheque" | "cash" | "card" | "other"; kind: "collection" | "reversal"; allocations: Alloc[]; reversesId?: string; reversedAt?: Date; remarks: string; ref?: string; txn: string; by: { id: string; role: string }; createdAt: Date };
const planned: Array<{ inv: Inv; date: string; amount: number }> = [];
const roundDown = (minor: number, step: number) => Math.max(step, Math.floor(minor / step) * step);
for (const inv of invoicesList) {
  if (inv.status !== "issued" || inv.cancelAt) continue;
  const p = inv.c.profile;
  const yesterday = addDays(TODAY, -1);
  const snap = (date: string) => {
    if (p !== "good") return date;
    const [y, m] = date.split("-").map(Number);
    let candidate = `${y}-${String(m).padStart(2, "0")}-${String(inv.c.cycleDay).padStart(2, "0")}`;
    if (candidate < date) candidate = addDays(monthStart(diffMonths(`${y}-${String(m).padStart(2, "0")}-01`) + 1), inv.c.cycleDay - 1);
    return diffDays(date, candidate) <= 12 ? candidate : date;
  };
  const schedule = (date: string, amount: number) => { const d = snap(date); if (d <= yesterday && d >= inv.date) planned.push({ inv, date: d, amount }); };
  if (p === "good" || p === "archived") {
    if (inv.c.name.startsWith("Pune Office")) schedule(addDays(inv.date, int(3, 10)), inv.amount);
    else if (chance(0.88)) schedule(addDays(inv.due, int(-10, 6)), inv.amount);
    else { const first = roundDown(Math.round(inv.amount * (0.4 + rand() * 0.3)), 50_000); schedule(addDays(inv.due, int(-5, 5)), first); schedule(addDays(inv.due, int(12, 30)), inv.amount - first); }
  } else if (p === "slow" || (p === "disputer" && chance(0.5))) {
    const r = rand();
    if (r < 0.5) schedule(addDays(inv.due, int(15, 70)), inv.amount);
    else if (r < 0.78) schedule(addDays(inv.due, int(5, 45)), roundDown(Math.round(inv.amount * (0.3 + rand() * 0.4)), 100_000));
  } else if (p === "defaulter") {
    if (chance(0.3)) schedule(addDays(inv.due, int(10, 60)), roundDown(Math.round(inv.amount * (0.1 + rand() * 0.3)), 100_000));
  } else if (p === "new") {
    if (chance(0.3)) schedule(addDays(inv.date, int(5, 15)), inv.amount);
  }
}
const pays: Pay[] = [];
const MODES = ["bank_transfer", "bank_transfer", "bank_transfer", "bank_transfer", "upi", "upi", "cheque", "cheque", "cash", "card", "other"] as const;
const txnFor = (mode: Pay["mode"]) => mode === "bank_transfer" ? `${pick(["SBIN", "HDFC", "ICIC", "UTIB", "KKBK", "BARB"])}R5${digits(10)}` : mode === "upi" ? `UPI/${digits(12)}` : mode === "cheque" ? `Chq ${digits(6)} – ${pick(["HDFC Bank", "SBI", "Bank of Maharashtra", "Cosmos Bank", "ICICI Bank", "Saraswat Bank"])}` : mode === "card" ? `Card **** ${digits(4)} · Auth ${digits(6)}` : mode === "other" ? "Adjusted against credit note" : "";
{
  const grouped = new Map<string, typeof planned>();
  for (const item of planned) { const key = `${item.inv.c.id}|${item.date}`; grouped.set(key, [...(grouped.get(key) ?? []), item]); }
  for (const items of grouped.values()) {
    const c = items[0]!.inv.c;
    const mode = c.size === "small" && chance(0.3) ? pick(["cash", "upi"] as const) : pick(MODES);
    pays.push({ id: randomUUID(), c, date: items[0]!.date, mode, kind: "collection", allocations: [...items.reduce((map, item) => map.set(item.inv.id, (map.get(item.inv.id) ?? 0) + item.amount), new Map<string, number>())].map(([invoiceId, amount]) => ({ invoiceId, amount })), remarks: chance(0.2) ? pick(["Received at office", "Collected by field officer", "Part payment as discussed", "TDS certificate to follow", "Payment against statement of account"]) : "", txn: txnFor(mode), by: c.city === "Aurangabad" ? U("sameer") : pick(accountsUsers), createdAt: notFuture(at(items[0]!.date, "11:00", int(0, 420))) });
  }
}
// Cheque bounces: the collection is reversed, and most customers pay again by NEFT.
{
  const bounceable = pays.filter((p) => p.mode === "cheque" && p.date <= addDays(TODAY, -25)).sort(() => rand() - 0.5).slice(0, 3);
  bounceable.forEach((original, index) => {
    const date = addDays(original.date, int(3, 6));
    original.reversedAt = notFuture(at(date, "16:30"));
    pays.push({ id: randomUUID(), c: original.c, date, mode: original.mode, kind: "reversal", reversesId: original.id, allocations: original.allocations, remarks: `Reversal: ${pick(["Cheque dishonoured – insufficient funds", "Cheque returned – signature mismatch", "Cheque dishonoured – payment stopped by drawer"])}`, txn: original.txn, by: U("neha"), createdAt: original.reversedAt });
    const repay = addDays(date, int(5, 12));
    if (index < 2 && repay < TODAY) pays.push({ id: randomUUID(), c: original.c, date: repay, mode: "bank_transfer", kind: "collection", allocations: original.allocations, remarks: "Replacement for dishonoured cheque", txn: txnFor("bank_transfer"), by: U("priya"), createdAt: notFuture(at(repay, "12:30")) });
  });
}
pays.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime());
{
  const seq = new Map<string, number>();
  for (const p of pays.filter((x) => x.kind === "collection")) { const fy = fiscalYear(p.date); const n = (seq.get(fy) ?? 0) + 1; seq.set(fy, n); p.ref = `RCPT/${fy}/${String(n).padStart(4, "0")}`; }
  for (const p of pays.filter((x) => x.kind === "reversal")) p.ref = `REV-${pays.find((o) => o.id === p.reversesId)!.ref}`;
}
// Outstanding balances follow from allocations.
const invById = new Map(invoicesList.map((inv) => [inv.id, inv]));
for (const inv of invoicesList) inv.outstanding = inv.status === "issued" && !inv.cancelAt ? inv.amount : 0;
for (const p of pays) for (const a of p.allocations) invById.get(a.invoiceId)!.outstanding += p.kind === "collection" ? -a.amount : a.amount;
for (const inv of invoicesList) if (inv.cancelAt) inv.status = "cancelled";
const paidBefore = (invoiceId: string, date: string) => pays.filter((p) => p.date < date).reduce((sum, p) => sum + p.allocations.filter((a) => a.invoiceId === invoiceId).reduce((s, a) => s + (p.kind === "collection" ? a.amount : -a.amount), 0), 0);

// Acknowledgement trail.
const ackRows: Array<typeof t.invoiceAcknowledgements.$inferInsert> = [];
for (const inv of invoicesList) {
  if (inv.status === "draft" || !inv.issuedAt) continue;
  const age = diffDays(inv.date, TODAY);
  const contact = inv.c.contacts.find((x) => x.designation !== "Owner") ?? inv.c.contacts[0];
  const r = rand();
  let final: Inv["ack"] = age < 3 ? (chance(0.5) ? "not_shared" : "shared") : inv.c.profile === "disputer" && r < 0.5 ? "disputed" : r < 0.7 ? "acknowledged" : r < 0.82 ? "shared" : r < 0.87 ? "rejected" : "not_shared";
  if (inv.status === "cancelled" && final !== "not_shared") final = "shared";
  inv.ack = final;
  if (final === "not_shared") continue;
  const sharedAt = notFuture(addTime(inv.issuedAt, int(30, 2400)));
  ackRows.push({ organizationId: orgId, invoiceId: inv.id, status: "shared", eventAt: sharedAt, remarks: pick(["Shared on WhatsApp with delivery", "Emailed PDF to accounts", "Hard copy handed over with goods", ""]), recordedBy: inv.by.id, createdAt: sharedAt });
  audit(inv.by, "invoice.acknowledgement_updated", "invoice", inv.id, sharedAt, { after: { status: "shared" } });
  if (final === "shared") continue;
  const eventAt = notFuture(addTime(sharedAt, int(600, 7 * 1440)));
  const remarks = final === "acknowledged" ? pick(["Signed and stamped copy received", "Acknowledged on email", "Goods received in good condition", "GRN number shared"]) : final === "rejected" ? pick(["Rate mismatch with PO – customer wants revised invoice", "PO number missing on invoice"]) : pick(["Short supply – 12 cases damaged in transit", "Customer claims scheme discount not applied", "Quality issue raised on 2 batches", "Quantity mismatch vs delivery challan"]);
  ackRows.push({ organizationId: orgId, invoiceId: inv.id, status: final, eventAt, responsiblePersonName: contact?.name ?? "Shop owner", responsiblePersonDesignation: contact?.designation ?? "Owner", remarks, recordedBy: inv.by.id, createdAt: eventAt });
  audit(inv.by, "invoice.acknowledgement_updated", "invoice", inv.id, eventAt, { after: { status: final }, reason: remarks });
}

await insertMany(t.invoices, invoicesList.map((inv) => ({
  id: inv.id, organizationId: orgId, customerId: inv.c.id, invoiceNumber: inv.number, invoiceDate: inv.date, dueDate: inv.due, creditDays: inv.creditDays, termSource: inv.term,
  amountMinor: inv.amount, currency: "INR", outstandingMinor: inv.outstanding, documentStatus: inv.status, acknowledgementStatus: inv.ack,
  partySnapshot: inv.status === "draft" ? null : { displayName: inv.c.name, companyName: inv.c.company, gstin: inv.c.gstin, billingAddress: inv.c.billing },
  notes: inv.notes, cancellation: inv.cancelAt ? { reason: inv.cancelReason!, cancelledBy: U("neha").id, cancelledAt: at(inv.cancelAt, "15:10").toISOString() } : null,
  issuedAt: inv.issuedAt, issuedBy: inv.issuedAt ? inv.by.id : null, createdBy: inv.by.id, updatedBy: inv.by.id, createdAt: inv.createdAt, updatedAt: inv.issuedAt ?? inv.createdAt,
})));
await insertMany(t.invoiceAcknowledgements, ackRows);
await insertMany(t.payments, pays.map((p) => ({
  id: p.id, organizationId: orgId, customerId: p.c.id, kind: p.kind, reversesPaymentId: p.reversesId ?? null, paymentReference: p.ref!, paymentDate: p.date, mode: p.mode,
  transactionReference: p.txn, amountMinor: p.allocations.reduce((sum, a) => sum + a.amount, 0), currency: "INR", remarks: p.remarks, status: "posted" as const,
  idempotencyKey: randomUUID(), reversedAt: p.reversedAt ?? null, recordedBy: p.by.id, createdAt: p.createdAt,
})));
await insertMany(t.paymentAllocations, pays.flatMap((p) => p.allocations.map((a, position) => ({ paymentId: p.id, organizationId: orgId, position, invoiceId: a.invoiceId, bucket: "principal" as const, amountMinor: a.amount }))));
{
  const ledger: Array<typeof t.ledgerEntries.$inferInsert> = [];
  for (const inv of invoicesList) {
    if (!inv.issuedAt) continue;
    ledger.push({ organizationId: orgId, customerId: inv.c.id, invoiceId: inv.id, type: "invoice_issued", amountMinor: inv.amount, effectiveDate: inv.date, recordedBy: inv.by.id, createdAt: inv.issuedAt });
    if (inv.cancelAt) ledger.push({ organizationId: orgId, customerId: inv.c.id, invoiceId: inv.id, type: "invoice_cancelled", amountMinor: -inv.amount, effectiveDate: inv.cancelAt, recordedBy: U("neha").id, createdAt: at(inv.cancelAt, "15:10") });
  }
  for (const p of pays) for (const a of p.allocations) ledger.push({ organizationId: orgId, customerId: p.c.id, invoiceId: a.invoiceId, type: p.kind === "collection" ? "payment_allocation" : "payment_reversal", amountMinor: p.kind === "collection" ? -a.amount : a.amount, paymentId: p.id, effectiveDate: p.date, recordedBy: p.by.id, createdAt: p.createdAt });
  await insertMany(t.ledgerEntries, ledger);
}
for (const inv of invoicesList) {
  audit(inv.by, "invoice.draft_created", "invoice", inv.id, inv.createdAt, { after: { invoiceNumber: inv.number, amountMinor: inv.amount } });
  if (inv.issuedAt) audit(inv.by, "invoice.issued", "invoice", inv.id, inv.issuedAt, { after: { status: "issued" } });
  if (inv.cancelAt) audit(U("neha"), "invoice.cancelled", "invoice", inv.id, at(inv.cancelAt, "15:10"), { after: { status: "cancelled" }, reason: inv.cancelReason });
}
for (const p of pays) {
  if (p.kind === "collection") audit(p.by, "payment.recorded", "payment", p.id, p.createdAt, { after: { paymentReference: p.ref, amountMinor: p.allocations.reduce((s, a) => s + a.amount, 0), mode: p.mode } });
  else audit(p.by, "payment.reversed", "payment", p.reversesId!, p.createdAt, { after: { reversalPaymentId: p.id }, reason: p.remarks.replace(/^Reversal: /, "") });
}

// ---------- 17. recovery: assignments, visits, call attempts, commitments ----------
type Status = (typeof t.ASSIGNMENT_STATUSES)[number];
type Asg = { id: string; c: Cust; invoices: Inv[]; assignee: { id: string; role: string }; assignedOn: string; status: Status; snapshot: number; deadline: string; priority: "low" | "medium" | "high"; closeReason?: string; closedAt?: Date };
const assignments: Asg[] = [];
const fieldTeam = { pune: [U("vikram"), U("sunil"), U("ganesh")], aurangabad: [U("anil")] };
const assigneeFor = (c: Cust) => (c.city === "Aurangabad" || c.city === "Nagpur" ? U("anil") : pick(fieldTeam.pune));
const lastPaymentDate = (inv: Inv) => pays.filter((p) => p.kind === "collection" && p.allocations.some((a) => a.invoiceId === inv.id)).map((p) => p.date).sort().at(-1);
const OPEN_CYCLE: Status[] = ["payment_committed", "follow_up_required", "in_progress", "visit_scheduled", "assigned", "escalated", "visit_completed", "payment_committed", "follow_up_required", "in_progress", "assigned", "visit_completed", "escalated", "visit_scheduled"];
let cycleIndex = 0;
for (const c of customers) {
  const live = invoicesList.filter((inv) => inv.c.id === c.id && inv.status === "issued");
  const overdueOpen = live.filter((inv) => inv.outstanding > 0 && inv.due < addDays(TODAY, -3)).sort((a, b) => a.due.localeCompare(b.due));
  const recoveredLate = live.filter((inv) => inv.outstanding === 0 && (lastPaymentDate(inv) ?? "") > addDays(inv.due, 12));
  const wantOpen = c.profile === "good" ? 0.3 : c.profile === "new" ? 0 : 0.9;
  for (let i = 0; i < overdueOpen.length && chance(wantOpen); i += 4) {
    const group = overdueOpen.slice(i, i + 4);
    const earliestDue = group[0]!.due;
    const assignedOn = [addDays(earliestDue, int(4, 10)), addDays(TODAY, -int(4, 48))].sort().at(-1)!;
    if (assignedOn > TODAY) continue;
    const snapshot = group.reduce((sum, inv) => sum + inv.amount - paidBefore(inv.id, assignedOn), 0);
    if (snapshot <= 0) continue;
    const partialAfter = group.some((inv) => inv.outstanding < inv.amount - paidBefore(inv.id, assignedOn));
    let status: Status = partialAfter ? "partially_recovered" : OPEN_CYCLE[cycleIndex++ % OPEN_CYCLE.length]!;
    if (c.profile === "disputer" && !partialAfter) status = pick(["escalated", "follow_up_required"] as const);
    let closeReason: string | undefined; let closedAt: Date | undefined;
    if (c.name.startsWith("Sai Krupa")) { status = "closed"; closeReason = "Business shut down; owner untraceable. Referred to legal for recovery."; closedAt = notFuture(at(addDays(assignedOn, 25), "17:00")); }
    const total = snapshot;
    assignments.push({ id: randomUUID(), c, invoices: group, assignee: c.name.startsWith("Om Sai") && i === 0 ? U("rahul") : assigneeFor(c), assignedOn, status, snapshot, deadline: addDays(assignedOn, int(4, 15)), priority: total > rupees(300000) ? "high" : total > rupees(80000) ? "medium" : pick(["low", "medium"] as const), closeReason, closedAt });
  }
  if (recoveredLate.length && chance(c.profile === "slow" ? 0.75 : 0.35)) {
    const group = recoveredLate.slice(0, 3);
    const firstPay = group.map((inv) => pays.filter((p) => p.allocations.some((a) => a.invoiceId === inv.id)).map((p) => p.date).sort()[0]!).sort()[0]!;
    const assignedOn = addDays(group.map((inv) => inv.due).sort()[0]!, int(3, 8));
    if (assignedOn >= firstPay) continue;
    const snapshot = group.reduce((sum, inv) => sum + inv.amount - paidBefore(inv.id, assignedOn), 0);
    if (snapshot <= 0) continue;
    const closed = chance(0.2);
    assignments.push({ id: randomUUID(), c, invoices: group, assignee: chance(0.2) ? U("rahul") : assigneeFor(c), assignedOn, status: closed ? "closed" : "fully_recovered", snapshot, deadline: addDays(assignedOn, int(5, 12)), priority: snapshot > rupees(300000) ? "high" : "medium", closeReason: closed ? "Customer settled directly with the Sales Head; receipt reconciled" : undefined, closedAt: closed ? at(lastPaymentDate(group[0]!) ?? assignedOn, "18:00") : undefined });
  }
}
// One brand-new case that nobody has picked up yet.
{
  const assignedInvoices = new Set(assignments.flatMap((a) => a.invoices.map((inv) => inv.id)));
  const fresh = invoicesList.find((inv) => inv.status === "issued" && inv.outstanding > 0 && inv.due < TODAY && !assignedInvoices.has(inv.id) && inv.c.profile === "good");
  if (fresh) assignments.push({ id: randomUUID(), c: fresh.c, invoices: [fresh], assignee: U("vikram"), assignedOn: TODAY, status: "not_assigned", snapshot: fresh.outstanding, deadline: addDays(TODAY, 7), priority: "low" });
}
const visitRows: Array<typeof t.recoveryVisits.$inferInsert> = [];
const callRows: Array<typeof t.recoveryCallAttempts.$inferInsert> = [];
const commitmentRows: Array<typeof t.commitments.$inferInsert> = [];
const DISCUSSION: Record<string, string[]> = {
  promised_payment: ["Owner agreed to clear the dues; will transfer by NEFT", "Accounts confirmed the payment is approved in this week's run", "Customer promised payment once their own collection comes in"],
  partial_payment_received: ["Collected part payment by cheque; balance promised next week", "Received cash part payment against the oldest invoice"],
  payment_already_made: ["Customer claims payment already done via NEFT – asked for UTR to reconcile"],
  payment_refused: ["Owner refused to pay citing pending credit note", "Customer refused – says rates were higher than agreed"],
  invoice_dispute: ["Customer disputes quantity; wants joint verification of delivery challans", "Dispute on scheme discount; escalated to sales"],
  goods_service_issue: ["Complaint about damaged cartons in last dispatch; wants replacement first"],
  person_unavailable: ["Owner not available; met staff who asked to come back on Monday", "Shop closed for local festival", "Accounts person on leave"],
  additional_time_requested: ["Requested 15 more days due to slow sales after the festive season", "Asked for time till month end – awaiting payment from their distributor"],
  business_closed: ["Shop found shut; neighbours say the business is closed", "Premises vacated – new tenant in place"],
  other: ["Met the purchase head; shared statement of account and ledger copy", "Reconciled ledger with customer's accountant"],
};
const NON_PAYMENT = ["Cash-flow crunch", "Awaiting collections from their customers", "Dispute on supplied quantity", "Owner travelling", "Business slowdown"];
const visitOutcomes: Record<Status, Array<(typeof t.VISIT_OUTCOMES)[number]>> = {
  not_assigned: [], assigned: [], visit_scheduled: [], in_progress: ["person_unavailable"],
  visit_completed: ["person_unavailable", "other"], follow_up_required: ["person_unavailable", "additional_time_requested"],
  payment_committed: ["additional_time_requested", "promised_payment"], partially_recovered: ["person_unavailable", "partial_payment_received"],
  fully_recovered: ["promised_payment", "promised_payment"], escalated: ["promised_payment", "payment_refused"], closed: ["person_unavailable", "business_closed"],
};
for (const a of assignments) {
  const contact = a.c.contacts[0];
  const coords = CITIES[a.c.city]!;
  const outcomes = [...visitOutcomes[a.status]];
  if (a.status === "in_progress" && chance(0.4)) outcomes.length = 0;
  if (a.status === "visit_completed" && chance(0.4)) outcomes.splice(0, 1);
  if (a.c.profile === "disputer" && a.status !== "fully_recovered") for (let i = 0; i < outcomes.length; i++) if (outcomes[i] === "payment_refused" || outcomes[i] === "additional_time_requested") outcomes[i] = pick(["invoice_dispute", "goods_service_issue"]);
  if (a.status === "closed" && a.closeReason?.startsWith("Customer settled")) outcomes.splice(0, outcomes.length, "payment_already_made");
  const finalPay = a.status === "fully_recovered" || a.status === "closed" ? a.invoices.map((inv) => lastPaymentDate(inv) ?? TODAY).sort().at(-1)! : TODAY;
  const span = Math.max(1, diffDays(a.assignedOn, finalPay));
  const outstandingNow = a.invoices.reduce((sum, inv) => sum + inv.outstanding, 0);
  outcomes.forEach((outcome, index) => {
    let visitDate = addDays(a.assignedOn, Math.max(1, Math.round(((index + 1) / (outcomes.length + 0.5)) * span)));
    if (a.status === "fully_recovered" && index === outcomes.length - 1) visitDate = addDays(finalPay, -int(2, 6)) > a.assignedOn ? addDays(finalPay, -int(2, 6)) : addDays(a.assignedOn, 1);
    if (visitDate > TODAY) visitDate = TODAY;
    const visitedAt = notFuture(at(visitDate, "11:00", int(0, 400)));
    const id = randomUUID();
    let commitmentId: string | null = null; let promisedDate: string | null = null; let promisedAmount: number | null = null;
    if (outcome === "promised_payment") {
      commitmentId = randomUUID();
      const isLast = index === outcomes.length - 1;
      let status: (typeof t.COMMITMENT_STATUSES)[number];
      let fulfilled = 0;
      if (a.status === "fully_recovered") { status = "fulfilled"; promisedDate = finalPay; promisedAmount = a.snapshot; fulfilled = promisedAmount; }
      else if (a.status === "payment_committed" && isLast) { status = "upcoming"; promisedDate = addDays(TODAY, pick([0, 2, 4, 6, 9, 15])); promisedAmount = roundDown(Math.round(outstandingNow * (0.4 + rand() * 0.6)), 100_000); }
      else { status = "missed"; promisedDate = addDays(visitDate, int(4, 9)); if (promisedDate >= TODAY) { status = "upcoming"; } promisedAmount = roundDown(Math.round(a.snapshot * (0.3 + rand() * 0.5)), 100_000); }
      commitmentRows.push({ id: commitmentId, organizationId: orgId, customerId: a.c.id, invoiceIds: a.invoices.map((inv) => inv.id), promisedAmountMinor: promisedAmount, promisedDate, delayReason: pick(["Awaiting payment from their distributor", "Cash flow tight after the festive season", "Board approval pending", "Bank limit renewal in progress"]), responsiblePerson: contact?.name ?? "Shop owner", recordedBy: a.assignee.id, sourceVisitId: id, status, fulfilledAmountMinor: fulfilled, evaluatedAt: status === "upcoming" ? null : notFuture(at(addDays(promisedDate, 1), "10:00")), createdAt: visitedAt, updatedAt: visitedAt });
      audit(a.assignee, "commitment.created", "commitment", commitmentId, visitedAt, { after: { promisedAmountMinor: promisedAmount, promisedDate } });
      if (status !== "upcoming") audit(U("neha"), "commitment.evaluated", "commitment", commitmentId, at(addDays(promisedDate, 1), "10:00"), { after: { status, fulfilledAmountMinor: fulfilled } });
    }
    visitRows.push({
      id, organizationId: orgId, assignmentId: a.id, customerId: a.c.id, invoiceIds: a.invoices.map((inv) => inv.id), employeeId: a.assignee.id, visitedAt,
      contactPersonName: outcome === "business_closed" ? "Neighbouring shop owner" : outcome === "person_unavailable" ? pick(["Shop staff", "Store helper", "Security at gate"]) : contact?.name ?? "Shop owner",
      contactDesignation: outcome === "person_unavailable" || outcome === "business_closed" ? "" : contact?.designation ?? "Owner",
      outcome, discussion: pick(DISCUSSION[outcome]!), nonPaymentReason: ["payment_refused", "invoice_dispute", "goods_service_issue", "additional_time_requested", "person_unavailable"].includes(outcome) ? pick(NON_PAYMENT) : "",
      promisedDate, promisedAmountMinor: promisedAmount, commitmentId,
      location: chance(0.75) ? { lat: Number((coords.lat + (rand() - 0.5) * 0.04).toFixed(6)), lng: Number((coords.lng + (rand() - 0.5) * 0.04).toFixed(6)), accuracyMeters: int(5, 40) } : null,
      remarks: chance(0.25) ? pick(["Shared ledger copy", "Next visit along with sales executive", "Customer asked for interest waiver", "Photo of shop front taken"]) : "", createdAt: visitedAt,
    });
    audit(a.assignee, "recovery.visit_recorded", "recovery_visit", id, visitedAt, { after: { outcome, contactPersonName: contact?.name ?? "" } });
  });
  if (a.status !== "not_assigned") {
    for (const inv of a.invoices) {
      for (let i = 0; i < int(0, 3); i++) {
        const when = notFuture(at(addDays(a.assignedOn, int(0, Math.max(0, diffDays(a.assignedOn, finalPay < TODAY ? finalPay : TODAY)))), "10:30", int(0, 420)));
        callRows.push({ organizationId: orgId, assignmentId: a.id, invoiceId: inv.id, customerId: a.c.id, employeeId: a.assignee.id, attemptedAt: when, createdAt: when, updatedAt: when });
        audit(a.assignee, "recovery.customer_call_attempted", "recovery_assignment", a.id, when, { after: { invoiceId: inv.id } });
      }
    }
  }
}
// Commitments recorded by the accounts team over the phone (no visit).
{
  const open = invoicesList.filter((inv) => inv.status === "issued" && inv.outstanding > 0 && !commitmentRows.some((c) => (c.invoiceIds ?? []).includes(inv.id)));
  const plan: Array<{ status: (typeof t.COMMITMENT_STATUSES)[number]; promised: string }> = [
    { status: "upcoming", promised: TODAY }, { status: "upcoming", promised: addDays(TODAY, 1) }, { status: "upcoming", promised: addDays(TODAY, 3) }, { status: "upcoming", promised: addDays(TODAY, 12) },
    { status: "upcoming", promised: addDays(TODAY, -3) }, { status: "upcoming", promised: addDays(TODAY, -6) },
    { status: "missed", promised: addDays(TODAY, -15) }, { status: "missed", promised: addDays(TODAY, -28) },
    { status: "partially_fulfilled", promised: addDays(TODAY, -20) }, { status: "cancelled", promised: addDays(TODAY, -9) }, { status: "cancelled", promised: addDays(TODAY, 4) },
  ];
  for (const item of plan) {
    const inv = open.splice(int(0, open.length - 1), 1)[0];
    if (!inv) break;
    const recordedBy = inv.c.city === "Aurangabad" ? U("sameer") : U("priya");
    const created = notFuture(at(addDays(item.promised, -int(5, 12)), "12:00", int(0, 240)));
    const promisedAmount = Math.max(rupees(1000), roundDown(Math.round(inv.outstanding * (0.5 + rand() * 0.5)), 50_000));
    const id = randomUUID();
    const evaluatedAt = item.status === "missed" || item.status === "partially_fulfilled" ? notFuture(at(addDays(item.promised, 1), "10:30")) : null;
    commitmentRows.push({ id, organizationId: orgId, customerId: inv.c.id, invoiceIds: [inv.id], promisedAmountMinor: promisedAmount, promisedDate: item.promised, delayReason: pick(["Customer's bank server issue", "Awaiting their customer's payment", "Partner travelling – cheque signatory unavailable", "GST refund awaited"]), responsiblePerson: inv.c.contacts[0]?.name ?? "Shop owner", recordedBy: recordedBy.id, status: item.status, fulfilledAmountMinor: item.status === "partially_fulfilled" ? roundDown(Math.round(promisedAmount * 0.4), 50_000) : 0, evaluatedAt, cancelReason: item.status === "cancelled" ? pick(["Customer raised a quality dispute; commitment withdrawn", "Replaced by a revised commitment after discussion"]) : null, createdAt: created, updatedAt: evaluatedAt ?? created });
    audit(recordedBy, "commitment.created", "commitment", id, created, { after: { promisedAmountMinor: promisedAmount, promisedDate: item.promised } });
    if (item.status === "cancelled") audit(U("neha"), "commitment.cancelled", "commitment", id, notFuture(addTime(created, 2880)), { after: { status: "cancelled" } });
  }
}
await insertMany(t.recoveryAssignments, assignments.map((a) => {
  const createdAt = notFuture(at(a.assignedOn, "10:00", int(0, 300)));
  return { id: a.id, organizationId: orgId, customerId: a.c.id, invoiceIds: a.invoices.map((inv) => inv.id), outstandingSnapshotMinor: a.snapshot, assigneeId: a.assignee.id, assignedBy: pick([U("neha").id, U("priya").id, admin.userId!]), assignedOn: a.assignedOn, visitDeadline: a.deadline, priority: a.priority, instructions: pick(["Meet the owner personally and collect at least 50%", "Carry ledger copy and signed delivery challans", "Customer prefers morning visits before 11 am", "Coordinate with sales executive before visiting", "Collect post-dated cheques if full payment not possible", ""]), status: a.status, closeReason: a.closeReason ?? null, closedAt: a.closedAt ?? null, createdAt, updatedAt: createdAt };
}));
for (const a of assignments) {
  audit(U("neha"), "recovery.assigned", "recovery_assignment", a.id, at(a.assignedOn, "10:00"), { after: { customerId: a.c.id, assigneeId: a.assignee.id, priority: a.priority } });
  if (!["assigned", "not_assigned"].includes(a.status)) audit(a.assignee, "recovery.status_changed", "recovery_assignment", a.id, a.closedAt ?? at(addDays(a.assignedOn, 2), "17:00"), { before: { status: "assigned" }, after: { status: a.status }, reason: a.closeReason });
}
// Commitments first (visits reference them, they reference visits – break the cycle by inserting visits without the link, then linking).
await insertMany(t.recoveryVisits, visitRows.map((v) => ({ ...v, commitmentId: null })));
await insertMany(t.commitments, commitmentRows);
for (const v of visitRows.filter((row) => row.commitmentId)) await db.update(t.recoveryVisits).set({ commitmentId: v.commitmentId }).where(eq(t.recoveryVisits.id, v.id!));
await insertMany(t.recoveryCallAttempts, callRows);

// ---------- 18. visitors ----------
{
  const v1Fields: t.VisitorFormField[] = [
    { key: "full_name", label: "Full name", type: "text", placeholder: "As per ID card", required: true, enabled: true, order: 0, minLength: 3, maxLength: 80, options: [] },
    { key: "mobile", label: "Mobile number", type: "mobile", placeholder: "10-digit mobile", required: true, enabled: true, order: 1, options: [] },
    { key: "email", label: "Email", type: "email", required: false, enabled: true, order: 2, options: [] },
    { key: "company", label: "Company / Organisation", type: "text", required: false, enabled: true, order: 3, options: [] },
    { key: "purpose", label: "Purpose of visit", type: "dropdown", required: true, enabled: true, order: 4, options: ["Business meeting", "Interview", "Delivery", "Vendor / Supplier", "Maintenance", "Personal"] },
    { key: "host", label: "Whom do you want to meet?", type: "text", required: true, enabled: true, order: 5, options: [] },
  ];
  const v2Fields: t.VisitorFormField[] = [
    ...v1Fields,
    { key: "companions", label: "Accompanying persons", type: "number", helpText: "Number of people with you", required: false, enabled: true, order: 6, defaultValue: 0, options: [], validation: { min: 0, max: 10 } },
    { key: "has_vehicle", label: "Arrived by vehicle?", type: "checkbox", required: false, enabled: true, order: 7, defaultValue: false, options: [] },
    { key: "vehicle_number", label: "Vehicle number", type: "text", placeholder: "MH12 AB 1234", required: true, enabled: true, order: 8, options: [], visibility: { key: "has_vehicle", operator: "equals", value: true } },
    { key: "id_proof", label: "ID proof shown", type: "radio", required: true, enabled: true, order: 9, options: ["Aadhaar", "PAN", "Driving Licence", "Passport", "Company ID"] },
    { key: "laptop", label: "Carrying laptop / storage device?", type: "checkbox", required: false, enabled: true, order: 10, defaultValue: false, options: [] },
    { key: "remarks", label: "Remarks", type: "textarea", required: false, enabled: false, order: 11, options: [] },
  ];
  const contractorFields: t.VisitorFormField[] = [
    { key: "full_name", label: "Full name", type: "text", required: true, enabled: true, order: 0, options: [] },
    { key: "mobile", label: "Mobile number", type: "mobile", required: true, enabled: true, order: 1, options: [] },
    { key: "contractor", label: "Contractor firm", type: "text", required: true, enabled: true, order: 2, options: [] },
    { key: "work_order", label: "Work order number", type: "text", required: true, enabled: true, order: 3, options: [], validation: { pattern: "^WO-[0-9]{4,}$" } },
    { key: "tools", label: "Tools carried", type: "multiselect", required: false, enabled: true, order: 4, options: ["Drill machine", "Welding kit", "Ladder", "Hand tools", "Cutting machine"] },
    { key: "safety", label: "Safety induction completed", type: "checkbox", required: true, enabled: true, order: 5, options: [] },
    { key: "work_date", label: "Work date", type: "date", required: true, enabled: true, order: 6, options: [] },
  ];
  const eventFields: t.VisitorFormField[] = [
    { key: "full_name", label: "Dealer name", type: "text", required: true, enabled: true, order: 0, options: [] },
    { key: "mobile", label: "Mobile number", type: "mobile", required: true, enabled: true, order: 1, options: [] },
    { key: "city", label: "City", type: "text", required: true, enabled: true, order: 2, options: [] },
    { key: "arrival", label: "Arrival time", type: "time", required: false, enabled: true, order: 3, options: [] },
  ];
  const created = (days: number) => at(addDays(TODAY, -days), "11:00");
  const mainForm = randomUUID(); const contractorForm = randomUUID(); const eventForm = randomUUID();
  await insertMany(t.visitorForms, [
    { id: mainForm, organizationId: orgId, name: "Visitor Registration", description: "Front desk and gate registration for all visitors", status: "published", version: 2, fields: v2Fields, createdBy: admin.userId!, createdAt: created(120), updatedAt: created(40) },
    { id: contractorForm, organizationId: orgId, name: "Contractor & Vendor Entry", description: "Work permit details for contractors (draft – pending safety team review)", status: "draft", version: 1, fields: contractorFields, createdBy: U("rohan").id, createdAt: created(6), updatedAt: created(6) },
    { id: eventForm, organizationId: orgId, name: "Dealer Meet 2026 Registration", description: "One-time registration for the annual dealer meet", status: "archived", version: 1, fields: eventFields, createdBy: admin.userId!, createdAt: created(150), updatedAt: created(95) },
  ]);
  const v1Id = randomUUID(); const v2Id = randomUUID(); const eventV = randomUUID();
  await insertMany(t.visitorFormVersions, [
    { id: v1Id, formId: mainForm, version: 1, name: "Visitor Registration", fields: v1Fields, createdAt: created(120) },
    { id: v2Id, formId: mainForm, version: 2, name: "Visitor Registration", fields: v2Fields, createdAt: created(40) },
    { formId: contractorForm, version: 1, name: "Contractor & Vendor Entry", fields: contractorFields, createdAt: created(6) },
    { id: eventV, formId: eventForm, version: 1, name: "Dealer Meet 2026 Registration", fields: eventFields, createdAt: created(150) },
  ]);
  const passes = { reception: randomUUID(), gate: randomUUID(), old: randomUUID(), event: randomUUID() };
  await insertMany(t.visitorPasses, [
    { id: passes.reception, organizationId: orgId, formId: mainForm, formVersion: 2, versionId: v2Id, code: hex(16), label: "Reception – Baner HQ", status: "active", createdBy: admin.userId!, createdAt: created(40) },
    { id: passes.gate, organizationId: orgId, formId: mainForm, formVersion: 2, versionId: v2Id, code: hex(16), label: "Warehouse Gate – Chakan", status: "active", createdBy: admin.userId!, createdAt: created(39) },
    { id: passes.old, organizationId: orgId, formId: mainForm, formVersion: 1, versionId: v1Id, code: hex(16), label: "Reception (old QR – replaced)", status: "disabled", createdBy: admin.userId!, createdAt: created(118) },
    { id: passes.event, organizationId: orgId, formId: eventForm, formVersion: 1, versionId: eventV, code: hex(16), label: "Dealer Meet QR", status: "disabled", createdBy: admin.userId!, createdAt: created(148) },
  ]);
  const VISITOR_FIRST = ["Rahul", "Akash", "Pranav", "Siddharth", "Omkar", "Rutuja", "Shruti", "Aniket", "Saurabh", "Komal", "Neeraj", "Ishaan", "Tanvi", "Mayur", "Ketan", "Snehal", "Harshad", "Pratik", "Divya", "Chetan", "Rohit", "Ankita", "Vaibhav", "Sakshi", "Manasi", "Kunal", "Aarti", "Hrishikesh", "Juned", "Fatima"];
  const VISITOR_LAST = ["Kulkarni", "Deshpande", "Jagtap", "Sutar", "Gore", "Chaudhari", "Khan", "Fernandes", "Pillai", "Reddy", "Mishra", "Yadav", "Bhat", "Kamble", "Nair", "Wagh", "Phadke", "Karve", "Lele", "Sathe"];
  const VISITOR_COMPANIES = ["Blue Dart Express", "Hindustan Unilever", "Tata Consumer Products", "Godrej Agrovet", "Bajaj Electricals", "Infosys BPM", "Quick Fix Services", "Om Logistics", "Delhivery", "Asian Paints", "Shree Ganesh Traders", "Kothari Distributors", "", "", ""];
  const hosts = PEOPLE.filter((p) => p.role && p.role !== "guard").map((p) => `${p.first} ${p.last}`);
  const regular = { name: "Mangesh Lad", mobile: "9822012345", company: "Quick Fix Services" };
  const regRows: Array<typeof t.visitorRegistrations.$inferInsert> = [];
  const photoRows: Array<typeof t.fileAssets.$inferInsert> = [];
  const photo = (name: string, when: Date, by: string | null) => { const id = randomUUID(); photoRows.push({ id, organizationId: orgId, purpose: "visitor_registration", originalFilename: `visitor-photo-${when.getTime()}.png`, mimeType: "image/png", sizeBytes: int(40_000, 95_000), storageUrl: avatarUrl(name, "64748b"), uploadedBy: by, createdAt: when }); return id; };
  for (let day = 50; day >= 0; day--) {
    const date = addDays(TODAY, -day);
    const count = weekday(date) === 0 ? int(0, 1) : int(2, 6);
    for (let i = 0; i < count; i++) {
      const isRegular = weekday(date) === 2 && i === 0;
      const name = isRegular ? regular.name : `${pick(VISITOR_FIRST)} ${pick(VISITOR_LAST)}`;
      const atGate = chance(0.35);
      const arrive = at(date, "09:30", int(0, 480));
      if (arrive > NOW) continue;
      const v1 = day > 40;
      const fields = v1 ? v1Fields : v2Fields;
      const purpose = isRegular ? "Maintenance" : atGate ? pick(["Delivery", "Vendor / Supplier", "Delivery", "Maintenance"]) : pick(["Business meeting", "Interview", "Vendor / Supplier", "Business meeting", "Personal"]);
      const hasVehicle = atGate || chance(0.3);
      const values: Record<string, unknown> = {
        full_name: name, mobile: isRegular ? regular.mobile : `${pick(["98", "97", "99", "90", "88", "70", "73"])}${digits(8)}`,
        email: chance(0.45) ? `${name.split(" ")[0]!.toLowerCase()}.${int(10, 99)}@mail.test` : "", company: isRegular ? regular.company : pick(VISITOR_COMPANIES),
        purpose, host: atGate ? "Mahesh Salunkhe" : pick(hosts),
      };
      if (!v1) Object.assign(values, { companions: chance(0.7) ? 0 : int(1, 3), has_vehicle: hasVehicle, ...(hasVehicle ? { vehicle_number: `MH${pick(["12", "14", "20", "04"])} ${letters(2)} ${digits(4)}` } : {}), id_proof: pick(["Aadhaar", "Driving Licence", "Company ID", "PAN"]), laptop: chance(0.3) });
      const channelRoll = rand();
      const channel = channelRoll < 0.55 ? "public" : channelRoll < 0.85 ? "guard" : "admin";
      const guard = atGate ? U("santosh") : U("ramesh");
      const passId = v1 ? (channel === "admin" ? null : passes.old) : channel === "admin" ? null : atGate ? passes.gate : passes.reception;
      const noShow = day > 0 && chance(0.07);
      const insideNow = day === 0 && chance(0.45);
      const overstayed = day === 1 && i === 0;
      const checkedInAt = noShow ? null : notFuture(addTime(arrive, int(2, 15)));
      const checkedOutAt = noShow || insideNow || overstayed ? null : notFuture(addTime(arrive, int(25, 210)));
      const checker = channel === "admin" ? U("priya") : guard;
      regRows.push({
        organizationId: orgId, passId, formId: mainForm, formVersion: v1 ? 1 : 2, formSnapshot: fields, values, visitorCode: randomUUID().replaceAll("-", ""),
        photoAssetId: chance(0.6) ? photo(name, arrive, channel === "public" ? null : guard.id) : null,
        checkedInPhotoAssetId: checkedInAt && chance(0.4) ? photo(name, checkedInAt, guard.id) : null,
        checkedOutPhotoAssetId: checkedOutAt && chance(0.15) ? photo(name, checkedOutAt, guard.id) : null,
        checkedInAt, checkedInBy: checkedInAt ? checker.id : null, checkedOutAt, checkedOutBy: checkedOutAt ? checker.id : null, channel, createdAt: arrive,
      });
    }
  }
  // Dealer meet registrations on the archived form.
  for (let i = 0; i < 14; i++) {
    const when = at(addDays(TODAY, -int(100, 110)), "10:00", int(0, 300));
    regRows.push({ organizationId: orgId, passId: passes.event, formId: eventForm, formVersion: 1, formSnapshot: eventFields, values: { full_name: pick(customers.filter((c) => c.profile !== "none")).name, mobile: `9${digits(9)}`, city: pick(Object.keys(CITIES)), arrival: `${int(9, 11)}:${pick(["00", "15", "30", "45"])}` }, visitorCode: randomUUID().replaceAll("-", ""), checkedInAt: chance(0.8) ? addTime(when, 1440 * 7) : null, checkedInBy: admin.userId!, channel: "public", createdAt: when });
  }
  await insertMany(t.fileAssets, photoRows);
  await insertMany(t.visitorRegistrations, regRows.map((row) => ({ ...row, checkedInBy: row.checkedInAt ? row.checkedInBy : null })));
}

// ---------- 19. compliance rules ----------
{
  const activation = (by: string, when: string, status: string) => ({ status, changedBy: by, changedAt: at(when, "12:00").toISOString() });
  await insertMany(t.complianceRuleSets, [
    { organizationId: orgId, name: "Provident Fund contribution", jurisdiction: "central" as const, industry: "Wholesale trade", employeeCategory: "All employees", ruleCode: "provident_fund" as const, parameters: [{ code: "employee_rate", value: 12, unit: "percent" }, { code: "employer_rate", value: 12, unit: "percent" }, { code: "wage_ceiling", value: 15000, unit: "INR per month" }], sources: [{ title: "EPFO – Employees' Provident Funds Scheme", url: "https://www.epfindia.gov.in", publishedOn: null }], effectiveFrom: "2025-04-01", effectiveTo: "2026-03-31", version: 1, status: "retired" as const, createdBy: admin.userId!, reviewedBy: superAdmin.id, reviewedAt: at("2025-04-05", "12:00"), legalReviewReference: "Legal memo LM/2025/04", activationHistory: [activation(admin.userId!, "2025-04-06", "active"), activation(admin.userId!, "2026-04-01", "retired")], createdAt: addTime(ORG_CREATED, 800) },
    { organizationId: orgId, name: "Provident Fund contribution", jurisdiction: "central" as const, industry: "Wholesale trade", employeeCategory: "All employees", ruleCode: "provident_fund" as const, parameters: [{ code: "employee_rate", value: 12, unit: "percent" }, { code: "employer_rate", value: 12, unit: "percent" }, { code: "wage_ceiling", value: 15000, unit: "INR per month" }, { code: "admin_charges", value: 0.5, unit: "percent" }], sources: [{ title: "EPFO – Employees' Provident Funds Scheme", url: "https://www.epfindia.gov.in", publishedOn: null }], effectiveFrom: "2026-04-01", version: 2, status: "active" as const, createdBy: admin.userId!, reviewedBy: superAdmin.id, reviewedAt: at("2026-03-28", "12:00"), legalReviewReference: "Legal memo LM/2026/03", activationHistory: [activation(admin.userId!, "2026-04-01", "active")], createdAt: addTime(ORG_CREATED, 801) },
    { organizationId: orgId, name: "Employees' State Insurance", jurisdiction: "central" as const, industry: "Wholesale trade", employeeCategory: "Wage up to ₹21,000", ruleCode: "employee_insurance" as const, parameters: [{ code: "employee_rate", value: 0.75, unit: "percent" }, { code: "employer_rate", value: 3.25, unit: "percent" }, { code: "wage_ceiling", value: 21000, unit: "INR per month" }], sources: [{ title: "ESIC – Contribution rates", url: "https://www.esic.gov.in", publishedOn: null }], effectiveFrom: "2026-04-01", version: 1, status: "active" as const, createdBy: admin.userId!, reviewedBy: superAdmin.id, reviewedAt: at("2026-03-29", "12:00"), legalReviewReference: "Legal memo LM/2026/04", activationHistory: [activation(admin.userId!, "2026-04-01", "active")], createdAt: addTime(ORG_CREATED, 802) },
    { organizationId: orgId, name: "Maharashtra Professional Tax", jurisdiction: "state" as const, regionCode: "MH", industry: "All", employeeCategory: "Salaried employees", ruleCode: "professional_tax" as const, parameters: [{ code: "slab_1_upto", value: 7500, unit: "INR" }, { code: "slab_2_upto", value: 10000, unit: "INR" }, { code: "slab_2_tax", value: 175, unit: "INR per month" }, { code: "slab_3_tax", value: 200, unit: "INR per month" }, { code: "february_tax", value: 300, unit: "INR" }], sources: [{ title: "Maharashtra GST Department – Profession Tax", url: "https://mahagst.gov.in", publishedOn: null }], effectiveFrom: "2026-04-01", version: 1, status: "validated" as const, createdBy: U("rohan").id, reviewedBy: superAdmin.id, reviewedAt: at(addDays(TODAY, -20), "12:00"), legalReviewReference: "CA opinion ref. VDX/PT/2026", createdAt: at(addDays(TODAY, -25), "12:00") },
    { organizationId: orgId, name: "Minimum wages – Shops & Establishments (Zone I)", jurisdiction: "state" as const, regionCode: "MH", industry: "Shops and commercial establishments", employeeCategory: "Unskilled", ruleCode: "minimum_wage" as const, parameters: [{ code: "basic_daily", value: 520, unit: "INR per day" }, { code: "vda_daily", value: 95, unit: "INR per day" }], sources: [{ title: "Labour Department, Government of Maharashtra", url: "https://mahakamgar.maharashtra.gov.in", publishedOn: null }], effectiveFrom: "2026-07-01", version: 1, status: "draft" as const, createdBy: U("rohan").id, createdAt: at(addDays(TODAY, -8), "12:00") },
    { organizationId: orgId, name: "Daily working hours & overtime", jurisdiction: "central" as const, industry: "Warehousing", employeeCategory: "Workers", ruleCode: "overtime" as const, parameters: [{ code: "daily_hours", value: 9, unit: "hours" }, { code: "weekly_hours", value: 48, unit: "hours" }, { code: "overtime_multiplier", value: 2, unit: "x ordinary rate" }], sources: [{ title: "Ministry of Labour & Employment", url: "https://labour.gov.in", publishedOn: null }], effectiveFrom: "2026-04-01", version: 1, status: "pending_review" as const, createdBy: U("rohan").id, createdAt: at(addDays(TODAY, -4), "12:00") },
    { organizationId: orgId, name: "Statutory bonus", jurisdiction: "central" as const, industry: "All", employeeCategory: "Wage up to ₹21,000", ruleCode: "bonus" as const, parameters: [{ code: "minimum_rate", value: 8.33, unit: "percent" }, { code: "maximum_rate", value: 20, unit: "percent" }], sources: [{ title: "Payment of Bonus Act", url: "https://labour.gov.in", publishedOn: null }], effectiveFrom: "2026-04-01", version: 1, status: "draft" as const, createdBy: admin.userId!, createdAt: at(addDays(TODAY, -2), "12:00") },
  ]);
}

// ---------- 20. audit trail ----------
audits.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
await insertMany(t.auditLogs, audits, 500);

// ---------- 21. payroll runs through the real payroll engine ----------
const actor: AuthContext = { userId: admin.userId!, role: "org_admin", organizationId: orgId, tokenVersion: 0, mustChangePassword: false };
const meta = { ip: "103.21.58.14", userAgent: "demo-seed" };
async function setRunTimes(runId: string, createdAt: Date, extra: Partial<typeof t.payrollRuns.$inferInsert> = {}) {
  await db.update(t.payrollRuns).set({ createdAt: notFuture(createdAt), ...extra }).where(eq(t.payrollRuns.id, runId));
}
async function retimeAudits(runId: string, base: Date) {
  const offsets: Record<string, number> = { "payroll.run_previewed": 0, "payroll.run_submitted": 90, "payroll.run_cancelled": 30, "payroll.run_approved": 1440, "payroll.run_finalized": 2880, "payroll.payment_recorded": 4320 };
  for (const [action, minutes] of Object.entries(offsets)) await db.update(t.auditLogs).set({ createdAt: notFuture(addTime(base, minutes)) }).where(and(eq(t.auditLogs.entityId, runId), eq(t.auditLogs.action, action)));
}
async function applyStatuses(stage: 1 | 2) {
  for (const item of PEOPLE.filter((p) => p.statusStage === stage)) {
    await db.update(t.workforceEmployees).set({ status: item.finalStatus! }).where(eq(t.workforceEmployees.id, item.profileId));
  }
}
async function payAll(runId: string, fraction: number, month: string, paidAt: Date) {
  const employees = await db.select({ employeeId: t.payrollRunEmployees.employeeId, net: t.payrollRunEmployees.netPayMinor, number: t.payrollRunEmployees.employeeNumber }).from(t.payrollRunEmployees).where(eq(t.payrollRunEmployees.runId, runId));
  const payable = employees.filter((e) => e.net > 0);
  const count = Math.round(payable.length * fraction);
  for (const [index, employee] of payable.entries()) {
    if (index >= count) break;
    const partial = fraction < 1 && index === count - 1;
    await recordPayrollPayment(actor, orgId, runId, { employeeId: employee.employeeId, amountMinor: partial ? Math.floor(employee.net / 2) : employee.net, reference: `SAL-${month}-${employee.number}` }, meta);
  }
  await db.update(t.payrollRunPayments).set({ recordedAt: notFuture(paidAt) }).where(eq(t.payrollRunPayments.runId, runId));
}
const runCreated = (end: string) => at(addDays(end, 2), "11:00");
{
  // Month M-2: fully paid.
  const run = await createPayrollRun(actor, orgId, "INR", { name: `${monthLabel(M2_START)} payroll`, periodStart: M2_START, periodEnd: M2_END }, meta);
  await submitPayrollRun(actor, orgId, run.id, meta);
  await approvePayrollRun(actor, orgId, run.id, meta);
  await finalizePayrollRun(actor, orgId, run.id, meta);
  await payAll(run.id, 1, M2_START.slice(0, 7), addTime(runCreated(M2_END), 4320));
  const base = runCreated(M2_END);
  await setRunTimes(run.id, base, { approvedAt: addTime(base, 1440), finalizedAt: addTime(base, 2880) });
  await retimeAudits(run.id, base);
  // Overtime and earnings that went into this payroll are now paid.
  await db.update(t.overtimeEntries).set({ status: "paid" }).where(and(eq(t.overtimeEntries.organizationId, orgId), eq(t.overtimeEntries.status, "approved"), inArray(t.overtimeEntries.id, otRows.filter((r) => r.workDate >= M2_START && r.workDate <= M2_END).map((r) => r.id!))));
  await db.update(t.dailyEarnings).set({ status: "paid" }).where(and(eq(t.dailyEarnings.organizationId, orgId), eq(t.dailyEarnings.status, "approved"), inArray(t.dailyEarnings.id, earningRows.filter((r) => r.earningDate >= M2_START && r.earningDate <= M2_END).map((r) => r.id!))));
  console.log(`  Payroll ${monthLabel(M2_START)}: paid (${run.employees.length} employees)`);
}
await applyStatuses(1);
{
  // Month M-1: a discarded preview, then a finalized run that is partially paid.
  const preview = await createPayrollRun(actor, orgId, "INR", { name: `${monthLabel(M1_START)} payroll – first preview`, periodStart: M1_START, periodEnd: M1_END }, meta);
  await cancelPayrollRun(actor, orgId, preview.id, meta);
  const previewAt = at(addDays(M1_END, 1), "16:00");
  await setRunTimes(preview.id, previewAt, { cancelledAt: notFuture(addTime(previewAt, 30)) });
  await retimeAudits(preview.id, previewAt);
  const run = await createPayrollRun(actor, orgId, "INR", { name: `${monthLabel(M1_START)} payroll`, periodStart: M1_START, periodEnd: M1_END }, meta);
  await submitPayrollRun(actor, orgId, run.id, meta);
  await approvePayrollRun(actor, orgId, run.id, meta);
  await finalizePayrollRun(actor, orgId, run.id, meta);
  const base = runCreated(M1_END);
  await payAll(run.id, 0.6, M1_START.slice(0, 7), addTime(base, 4320));
  await setRunTimes(run.id, base, { approvedAt: notFuture(addTime(base, 1440)), finalizedAt: notFuture(addTime(base, 2880)) });
  await retimeAudits(run.id, base);
  console.log(`  Payroll ${monthLabel(M1_START)}: partially paid (${run.employees.length} employees)`);
}
await applyStatuses(2);
{
  // Current month: draft preview.
  const run = await createPayrollRun(actor, orgId, "INR", { name: `${monthLabel(M0_START)} payroll (preview)`, periodStart: M0_START, periodEnd: M0_END }, meta);
  console.log(`  Payroll ${monthLabel(M0_START)}: draft preview (${run.employees.length} employees)`);
}

// ---------- summary ----------
const count = async (table: any) => db.$count(table, eq(table.organizationId, orgId));
const summary = {
  users: await count(t.users), employees: await count(t.workforceEmployees), customers: await count(t.customers), invoices: await count(t.invoices),
  payments: await count(t.payments), recoveryAssignments: await count(t.recoveryAssignments), visits: await count(t.recoveryVisits), callAttempts: await count(t.recoveryCallAttempts),
  commitments: await count(t.commitments), attendanceRecords: await count(t.attendanceRecords), attendanceAdjustments: await count(t.attendanceAdjustments),
  corrections: await count(t.attendanceCorrections), leaveRequests: await count(t.leaveRequests), overtimeEntries: await count(t.overtimeEntries),
  dailyEarnings: await count(t.dailyEarnings), payrollRuns: await count(t.payrollRuns), visitorRegistrations: await count(t.visitorRegistrations), auditLogs: await count(t.auditLogs),
};
console.table(summary);
const [org] = await db.select({ publicCode: t.organizations.publicCode }).from(t.organizations).where(eq(t.organizations.id, orgId));
console.log(`\nDemo organization ready: ${ORG_NAME} (public visitor code: ${org?.publicCode})`);
console.log(`Password for every login: ${PASSWORD}\n`);
console.table(PEOPLE.filter((p) => p.role).map((p) => ({ name: `${p.first} ${p.last}`, role: p.role, email: p.email, note: p.userDisabled ? "disabled (left company)" : p.mustChange ? "must change password" : "" })));
await disconnectDatabase();
