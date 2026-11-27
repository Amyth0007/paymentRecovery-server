import { Router, type RequestHandler } from "express";
import multer from "multer";
import { usesActionPermissions, type AuthConfig } from "../../common/auth/auth-context.js";
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
import { MAX_FILE_SIZE_BYTES, resolveImageMimeType, uploadParamsSchema } from "./files.schemas.js";
import { getFileAsset, saveUploadedFile } from "./files.service.js";
import { assertModuleAccess } from "../../common/middleware/module-guards.js";
import type { ModuleKey } from "../organizations/module-registry.js";
import type { Purpose } from "./files.service.js";
import { effectiveUserAccess } from "../users/user-access.service.js";

const PURPOSE_MODULE: Partial<Record<Purpose, ModuleKey>> = {
  invoice_document: "invoices",
  acknowledgement_evidence: "invoices",
  payment_support: "payments",
  visit_evidence: "recovery",
  commitment_evidence: "commitments",
  attendance_photo: "attendance",
  attendance_correction: "attendance",
  visitor_registration: "visitors",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    const imageMimeType = resolveImageMimeType(file.mimetype, file.originalname);
    if (imageMimeType) {
      file.mimetype = imageMimeType;
      cb(null, true);
    } else {
      cb(new AppError("VALIDATION_ERROR", "Only image files are accepted; PDF and other documents are not supported", 400));
    }
  },
});

const uploadSingleImage: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return next(new AppError("VALIDATION_ERROR", `Image must be ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB or smaller`, 413));
    }
    next(error);
  });
};

export function createFilesRouter(config: AuthConfig) {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  router.use(requireAuth, requirePasswordChanged, requireTenant, rejectMismatchedOrganization);

  router.post(
    "/upload",
    uploadSingleImage,
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError("VALIDATION_ERROR", "A file is required", 400);
      }
      const parsed = uploadParamsSchema.parse(req.body);
      const requiredModule = PURPOSE_MODULE[parsed.purpose];
      if (requiredModule) await assertModuleAccess(req.auth!.organizationId!, requiredModule, req.auth);
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
      const attendanceFile = fileAsset.purpose === "attendance_photo" || fileAsset.purpose === "attendance_correction";
      const requiredModule = PURPOSE_MODULE[fileAsset.purpose];
      if (requiredModule) await assertModuleAccess(req.auth!.organizationId!, requiredModule, req.auth);
      if (attendanceFile && fileAsset.uploadedBy?.toString() !== req.auth!.userId && req.auth!.role !== "org_admin") {
        const access = usesActionPermissions(req.auth!) ? await effectiveUserAccess(req.auth!.userId) : null;
        const canReviewEvidence = access?.actions.some((permission) => ["attendance.view_all", "attendance.adjust", "attendance.review_corrections"].includes(permission)) ?? false;
        if (!canReviewEvidence) throw new AppError("FORBIDDEN", "Attendance photos are only available to the employee and authorized attendance reviewers", 403);
      }
      if (attendanceFile) {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (fileAsset.storageUrl) {
          const upstream = await fetch(fileAsset.storageUrl);
          if (!upstream.ok) throw new AppError("FILE_CONTENT_UNAVAILABLE", "Attendance photo could not be loaded", 502);
          res.setHeader("Content-Type", fileAsset.mimeType);
          res.send(Buffer.from(await upstream.arrayBuffer()));
          return;
        }
        if (!absolutePath) throw new AppError("NOT_FOUND", "Attendance photo content was not found", 404);
        res.setHeader("Content-Type", fileAsset.mimeType);
        res.sendFile(absolutePath);
        return;
      }
      if (req.query.inline === "true") {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, max-age=300");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
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
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(fileAsset.originalFilename)}"`,
      );
      res.sendFile(absolutePath);
    }),
  );

  return router;
}
