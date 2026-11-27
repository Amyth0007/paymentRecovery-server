import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { and, eq } from "drizzle-orm";
import { isUuid } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import { fileAssets, type FILE_PURPOSES } from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

export type Purpose = (typeof FILE_PURPOSES)[number];

export async function ensureUploadDir(organizationId: string, purpose: string): Promise<string> {
  const dir = path.join(UPLOAD_ROOT, organizationId, purpose);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveUploadedFile(
  actor: AuthContext,
  organizationId: string,
  purpose: Purpose,
  file: Express.Multer.File,
  meta: RequestMeta,
) {
  const env = loadEnv();
  let storagePath = "";
  let storageUrl: string | null = null;
  let cloudinaryPublicId: string | null = null;

  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `paymentRecovery/${organizationId}/${purpose}`;
    const signature = createHash("sha1")
      .update(`folder=${folder}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`)
      .digest("hex");
    const body = new FormData();
    const uploadBytes = new Uint8Array(file.buffer.byteLength);
    uploadBytes.set(file.buffer);
    body.append("file", new Blob([uploadBytes.buffer as ArrayBuffer]), file.originalname);
    body.append("api_key", env.CLOUDINARY_API_KEY);
    body.append("timestamp", String(timestamp));
    body.append("folder", folder);
    body.append("signature", signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: "POST", body });
    const result = await response.json() as { secure_url?: string; public_id?: string; error?: { message?: string } };
    if (!response.ok || !result.secure_url || !result.public_id) {
      throw new AppError("UPLOAD_FAILED", result.error?.message || "Cloudinary upload failed", 502);
    }
    storageUrl = result.secure_url;
    cloudinaryPublicId = result.public_id;
  } else {
  const targetDir = await ensureUploadDir(organizationId, purpose);
  const ext = path.extname(file.originalname);
  const storedName = `${randomUUID()}${ext}`;
  const fullPath = path.join(targetDir, storedName);
  await fs.writeFile(fullPath, file.buffer);
  storagePath = path.join(organizationId, purpose, storedName);
  }

  const [fileAsset] = await db.insert(fileAssets).values({
    organizationId,
    purpose,
    originalFilename: file.originalname.trim(),
    mimeType: file.mimetype,
    sizeBytes: file.size,
    storagePath,
    storageUrl,
    cloudinaryPublicId,
    uploadedBy: actor.userId,
  }).returning();
  if (!fileAsset) throw new Error("File asset insert returned no row");

  await recordAudit({
    actor,
    action: "file.uploaded",
    entityType: "file",
    entityId: fileAsset.id,
    organizationId,
    after: { purpose, filename: file.originalname, sizeBytes: file.size },
    meta,
  });

  return {
    id: fileAsset.id,
    purpose: fileAsset.purpose,
    originalFilename: fileAsset.originalFilename,
    mimeType: fileAsset.mimeType,
    sizeBytes: fileAsset.sizeBytes,
    createdAt: fileAsset.createdAt,
  };
}

/** `fileAsset` is the file_assets row (`id` instead of the former Mongoose `_id`). */
export async function getFileAsset(organizationId: string, fileId: string) {
  const [fileAsset] = isUuid(fileId) && isUuid(organizationId)
    ? await db.select().from(fileAssets).where(and(eq(fileAssets.id, fileId), eq(fileAssets.organizationId, organizationId))).limit(1)
    : [];
  if (!fileAsset) {
    throw new AppError("NOT_FOUND", "File asset not found", 404);
  }
  const absolutePath = fileAsset.storagePath ? path.join(UPLOAD_ROOT, fileAsset.storagePath) : null;
  return {
    fileAsset,
    absolutePath,
  };
}

/** Stores a pass-scoped public visitor image using the configured Cloudinary backend or local fallback. */
export async function savePublicVisitorUpload(organizationId: string, file: Express.Multer.File) {
  const env = loadEnv();
  let storagePath = "";
  let storageUrl: string | null = null;
  let cloudinaryPublicId: string | null = null;
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `paymentRecovery/${organizationId}/visitor_registration`;
    const signature = createHash("sha1").update(`folder=${folder}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`).digest("hex");
    const body = new FormData();
    const bytes = new Uint8Array(file.buffer.byteLength); bytes.set(file.buffer);
    body.append("file", new Blob([bytes.buffer as ArrayBuffer]), file.originalname);
    body.append("api_key", env.CLOUDINARY_API_KEY); body.append("timestamp", String(timestamp)); body.append("folder", folder); body.append("signature", signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: "POST", body });
    const result = await response.json() as { secure_url?: string; public_id?: string; error?: { message?: string } };
    if (!response.ok || !result.secure_url || !result.public_id) throw new AppError("UPLOAD_FAILED", result.error?.message || "Cloudinary upload failed", 502);
    storageUrl = result.secure_url; cloudinaryPublicId = result.public_id;
  } else {
    const targetDir = await ensureUploadDir(organizationId, "visitor_registration");
    const ext = path.extname(file.originalname); const storedName = `${randomUUID()}${ext}`;
    await fs.writeFile(path.join(targetDir, storedName), file.buffer);
    storagePath = path.join(organizationId, "visitor_registration", storedName);
  }
  const [asset] = await db.insert(fileAssets).values({ organizationId, purpose: "visitor_registration", originalFilename: file.originalname.trim(), mimeType: file.mimetype, sizeBytes: file.size, storagePath, storageUrl, cloudinaryPublicId, uploadedBy: null }).returning();
  if (!asset) throw new AppError("UPLOAD_FAILED", "Visitor file record could not be created", 500);
  return { id: asset.id, originalFilename: asset.originalFilename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
}
