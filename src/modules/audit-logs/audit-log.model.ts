import { Schema, model } from "mongoose";

const auditLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, default: null, index: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });

export const AuditLogModel = model("AuditLog", auditLogSchema);
