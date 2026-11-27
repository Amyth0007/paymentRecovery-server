import { z } from "zod";
import { objectIdSchema } from "../../common/validators/schemas.js";

export const FILE_PURPOSES = [
  "invoice_document",
  "acknowledgement_evidence",
  "payment_support",
  "visit_evidence",
  "commitment_evidence",
  "attendance_photo",
  "attendance_correction",
  "visitor_registration",
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

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown"]);

export const isAllowedImageMimeType = (mimeType: string) => mimeType.toLowerCase().startsWith("image/");

/**
 * Returns the image MIME type for an upload, or null when it is not an image.
 * Camera captures on some mobile browsers arrive with a blank or generic MIME type,
 * so the file extension is used as a fallback in that case only.
 */
export function resolveImageMimeType(mimeType: string | undefined, originalName: string | undefined): string | null {
  const normalized = (mimeType ?? "").toLowerCase().trim();
  if (normalized.startsWith("image/")) return normalized;
  if (!GENERIC_MIME_TYPES.has(normalized)) return null;
  const extension = (originalName ?? "").toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSION_MIME[extension] ?? null;
}

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
