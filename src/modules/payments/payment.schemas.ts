import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const allocationInputSchema = z.object({
  invoiceId: objectIdSchema,
  amountMinor: z.coerce.number().int().min(1, "Allocation must be at least 1 paisa"),
});

export const createPaymentSchema = z.object({
  customerId: objectIdSchema,
  paymentReference: z.string().trim().min(1).max(100),
  paymentDate: z.string().regex(dateRegex, "Date must be YYYY-MM-DD"),
  mode: z.enum(["bank_transfer", "upi", "cheque", "cash", "card", "other"]),
  transactionReference: z.string().trim().max(100).optional(),
  amountMinor: z.coerce.number().int().min(1, "Payment amount must be at least 1 paisa"),
  allocations: z
    .array(allocationInputSchema)
    .min(1, "At least one invoice allocation is required"),
  fileAssetIds: z.array(objectIdSchema).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const paymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  customerId: objectIdSchema.optional(),
  invoiceId: objectIdSchema.optional(),
  kind: z.enum(["collection", "reversal"]).optional(),
  fromDate: z.string().regex(dateRegex).optional(),
  toDate: z.string().regex(dateRegex).optional(),
  sort: z.enum(["paymentDate", "-paymentDate", "createdAt", "-createdAt"]).default("-createdAt"),
});
