import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";
import {
  ASSIGNMENT_STATUSES,
  RECOVERY_PRIORITIES,
} from "./recovery-assignment.model.js";
import { VISIT_OUTCOMES } from "./recovery-visit.model.js";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createAssignmentSchema = z.object({
  customerId: objectIdSchema,
  invoiceIds: z.array(objectIdSchema).min(1, "Select at least one invoice"),
  assigneeId: objectIdSchema,
  visitDeadline: z.string().regex(dateRegex, "Deadline must be YYYY-MM-DD"),
  priority: z.enum(RECOVERY_PRIORITIES).default("medium"),
  instructions: z.string().trim().max(2000).optional(),
});

export const updateAssignmentStatusSchema = z.object({
  status: z.enum(ASSIGNMENT_STATUSES),
  closeReason: z.string().trim().max(500).optional(),
  instructions: z.string().trim().max(2000).optional(),
  assigneeId: objectIdSchema.optional(),
});

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).optional(),
});

export const createVisitSchema = z.object({
  contactPersonName: z.string().trim().min(1).max(120),
  contactDesignation: z.string().trim().max(100).optional(),
  outcome: z.enum(VISIT_OUTCOMES),
  discussion: z.string().trim().min(3).max(2000),
  nonPaymentReason: z.string().trim().max(1000).optional(),
  promisedDate: z.string().regex(dateRegex).optional(),
  promisedAmountMinor: z.coerce.number().int().min(1).optional(),
  fileAssetIds: z.array(objectIdSchema).min(1, "A visit photo is required"),
  location: locationSchema,
  remarks: z.string().trim().max(1000).optional(),
});

export const assignmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  customerId: objectIdSchema.optional(),
  assigneeId: objectIdSchema.optional(),
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
  priority: z.enum(RECOVERY_PRIORITIES).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["visitDeadline", "-visitDeadline", "createdAt", "-createdAt"]).default("-createdAt"),
});
