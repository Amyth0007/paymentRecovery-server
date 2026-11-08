import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createInvoiceDraftSchema = z
  .object({
    customerId: objectIdSchema,
    invoiceNumber: z.string().trim().min(1).max(100),
    invoiceDate: z.string().regex(dateRegex, "Date must be YYYY-MM-DD"),
    termSource: z.enum(["credit_days", "explicit_date"]),
    creditDays: z.coerce.number().int().min(0).max(365).optional(),
    dueDate: z.string().regex(dateRegex, "Date must be YYYY-MM-DD").optional(),
    amountMinor: z.coerce.number().int().min(1, "Amount must be at least 1 paisa"),
    notes: z.string().trim().max(2000).optional(),
    primaryFileAssetId: objectIdSchema.nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.termSource === "credit_days") {
        return data.creditDays !== undefined && data.creditDays >= 0;
      }
      return data.dueDate !== undefined && data.dueDate >= data.invoiceDate;
    },
    {
      message:
        "Provide either creditDays >= 0 or explicit dueDate on or after invoiceDate",
    },
  );

export const updateInvoiceDraftSchema = z.object({
  customerId: objectIdSchema.optional(),
  invoiceNumber: z.string().trim().min(1).max(100).optional(),
  invoiceDate: z.string().regex(dateRegex).optional(),
  termSource: z.enum(["credit_days", "explicit_date"]).optional(),
  creditDays: z.coerce.number().int().min(0).max(365).optional(),
  dueDate: z.string().regex(dateRegex).optional(),
  amountMinor: z.coerce.number().int().min(1).optional(),
  notes: z.string().trim().max(2000).optional(),
  primaryFileAssetId: objectIdSchema.nullable().optional(),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const updateAcknowledgementSchema = z.object({
  status: z.enum(["shared", "acknowledged", "rejected", "disputed"]),
  responsiblePersonName: z.string().trim().max(120).optional(),
  responsiblePersonDesignation: z.string().trim().max(120).optional(),
  remarks: z.string().trim().max(1000).optional(),
  fileAssetIds: z.array(objectIdSchema).optional(),
});

export const invoiceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  customerId: objectIdSchema.optional(),
  documentStatus: z.enum(["draft", "issued", "cancelled"]).optional(),
  acknowledgementStatus: z
    .enum(["not_shared", "shared", "acknowledged", "rejected", "disputed"])
    .optional(),
  search: z.string().trim().optional(),
  dateFrom: z.string().regex(dateRegex, "Date must be YYYY-MM-DD").optional(),
  dateTo: z.string().regex(dateRegex, "Date must be YYYY-MM-DD").optional(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]).optional(),
  overdueOnly: z.enum(["true", "false"]).optional(),
  dueTodayOnly: z.enum(["true", "false"]).optional(),
  outstandingOnly: z.enum(["true", "false"]).optional(),
  sort: z
    .enum([
      "dueDate",
      "-dueDate",
      "invoiceDate",
      "-invoiceDate",
      "amountMinor",
      "-amountMinor",
      "outstandingMinor",
      "-outstandingMinor",
      "createdAt",
      "-createdAt",
    ])
    .default("-createdAt"),
}).refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
  message: "Start date must be on or before end date",
});
