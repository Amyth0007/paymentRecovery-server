export const MODULES = {
  attendance: { name: "Attendance", description: "Location-based attendance and history" },
} as const;

export type ModuleKey = keyof typeof MODULES;
