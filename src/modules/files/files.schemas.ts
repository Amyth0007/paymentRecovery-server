import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";

export const FILE_PURPOSES = [
  "invoice_document",
  "acknowledgement_evidence",
  "payment_support",
  "visit_evidence",
  "commitment_evidence",
] as const;

export const uploadParamsSchema = z.object({
  purpose: z.enum(FILE_PURPOSES),
});

export const fileQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  purpose: z.enum(FILE_PURPOSES).optional(),
});

export const fileIdParamSchema = z.object({
  id: objectIdSchema,
});

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
