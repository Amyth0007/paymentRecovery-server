import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";
import { COMMITMENT_STATUSES } from "./commitment.model.js";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createCommitmentSchema = z.object({
  customerId: objectIdSchema,
  invoiceIds: z.array(objectIdSchema).min(1, "Select at least one invoice"),
  promisedAmountMinor: z.coerce.number().int().min(1, "Promised amount must be at least 1 paisa"),
  promisedDate: z.string().regex(dateRegex, "Date must be YYYY-MM-DD"),
  delayReason: z.string().trim().max(1000).optional(),
  responsiblePerson: z.string().trim().min(1).max(120),
  fileAssetIds: z.array(objectIdSchema).optional(),
  sourceVisitId: objectIdSchema.nullable().optional(),
});

export const cancelCommitmentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const evaluateCommitmentSchema = z.object({
  status: z.enum(["fulfilled", "partially_fulfilled", "missed"]),
  fulfilledAmountMinor: z.coerce.number().int().min(0).default(0),
});

export const commitmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  customerId: objectIdSchema.optional(),
  status: z.enum(COMMITMENT_STATUSES).optional(),
  fromDate: z.string().regex(dateRegex).optional(),
  toDate: z.string().regex(dateRegex).optional(),
  sort: z.enum(["promisedDate", "-promisedDate", "createdAt", "-createdAt"]).default("-promisedDate"),
});
