import { Router } from "express";
import multer from "multer";
import type { AuthConfig } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import {
  createRequireAuth,
  rejectMismatchedOrganization,
  requirePasswordChanged,
  requireTenant,
} from "../../common/middleware/auth-guards.js";
import { sendSuccess } from "../../common/utils/api-response.js";
import { requestMeta } from "../audit-logs/audit.service.js";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, uploadParamsSchema } from "./files.schemas.js";
import { getFileAsset, saveUploadedFile } from "./files.service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number])) {
      cb(null, true);
    } else {
      cb(new AppError("VALIDATION_ERROR", `Unsupported file type: ${file.mimetype}`, 400));
    }
  },
});

export function createFilesRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, rejectMismatchedOrganization);

  router.post(
    "/upload",
    upload.single("file"),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError("VALIDATION_ERROR", "A file is required", 400);
      }
      const parsed = uploadParamsSchema.parse(req.body);
      const result = await saveUploadedFile(
        req.auth!,
        req.auth!.organizationId!,
        parsed.purpose,
        req.file,
        requestMeta(req),
      );
      sendSuccess(res, result, undefined, 201);
    }),
  );

  router.get(
    "/:id/download",
    asyncHandler(async (req, res) => {
      const { fileAsset, absolutePath } = await getFileAsset(
        req.auth!.organizationId!,
        req.params.id as string,
      );
      if (req.query.inline === "true") {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, max-age=300");
        if (fileAsset.storageUrl) {
          const upstream = await fetch(fileAsset.storageUrl);
          if (!upstream.ok) {
            throw new AppError("FILE_CONTENT_UNAVAILABLE", `Cloudinary returned ${upstream.status} for this file`, 502);
          }
          res.setHeader("Content-Type", upstream.headers.get("content-type") || fileAsset.mimeType);
          res.send(Buffer.from(await upstream.arrayBuffer()));
          return;
        }
        if (!absolutePath) throw new AppError("NOT_FOUND", "File content was not found", 404);
        res.setHeader("Content-Type", fileAsset.mimeType);
        res.sendFile(absolutePath);
        return;
      }
      if (fileAsset.storageUrl) {
        res.redirect(fileAsset.storageUrl);
        return;
      }
      if (!absolutePath) throw new AppError("NOT_FOUND", "File content was not found", 404);
      res.setHeader("Content-Type", fileAsset.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(fileAsset.originalFilename)}"`,
      );
      res.sendFile(absolutePath);
    }),
  );

  return router;
}
