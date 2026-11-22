import { AppError } from "../../common/errors/app-error.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { OrganizationModel } from "../organizations/organization.model.js";
import { ComplianceRuleSetModel } from "./compliance.model.js";
import type { complianceReviewSchema, complianceRuleSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type RuleInput = z.infer<typeof complianceRuleSchema>;

export async function listComplianceRules(organizationId: string) {
  const rules = await ComplianceRuleSetModel.find({ organizationId }).sort({ ruleCode: 1, effectiveFrom: -1, version: -1 }).lean();
  return rules.map((rule) => ({ id: rule._id.toString(), name: rule.name, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, industry: rule.industry, employeeCategory: rule.employeeCategory, ruleCode: rule.ruleCode, parameters: rule.parameters, sources: rule.sources, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, version: rule.version, status: rule.status, legalReviewReference: rule.legalReviewReference, reviewedAt: rule.reviewedAt }));
}

export async function listPendingComplianceRules() {
  const rules = await ComplianceRuleSetModel.find({ status: "pending_review" }).populate("organizationId", "name").sort({ createdAt: 1 }).lean();
  return rules.map((rule: any) => ({ id: rule._id.toString(), organization: rule.organizationId ? { id: rule.organizationId._id.toString(), name: rule.organizationId.name } : null, name: rule.name, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, industry: rule.industry, employeeCategory: rule.employeeCategory, ruleCode: rule.ruleCode, parameters: rule.parameters, sources: rule.sources, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, version: rule.version, createdAt: rule.createdAt }));
}

export async function createComplianceRule(actor: AuthContext, organizationId: string, input: RuleInput, meta: RequestMeta) {
  const matching = await ComplianceRuleSetModel.findOne({ organizationId, ruleCode: input.ruleCode, jurisdiction: input.jurisdiction, regionCode: input.regionCode, industry: input.industry, employeeCategory: input.employeeCategory }).sort({ version: -1 }).select("version");
  const rule = await ComplianceRuleSetModel.create({ ...input, organizationId, version: (matching?.version ?? 0) + 1, status: "draft", createdBy: actor.userId });
  await recordAudit({ actor, action: "compliance.rule_drafted", entityType: "compliance_rule_set", entityId: rule._id.toString(), organizationId, after: { name: rule.name, ruleCode: rule.ruleCode, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, version: rule.version, effectiveFrom: rule.effectiveFrom }, meta });
  return { id: rule._id.toString(), name: rule.name, ruleCode: rule.ruleCode, version: rule.version, status: rule.status };
}

export async function submitComplianceRule(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  const rule = await ComplianceRuleSetModel.findOneAndUpdate({ _id: id, organizationId, status: "draft", sources: { $ne: [] } }, { $set: { status: "pending_review" } }, { new: true });
  if (!rule) throw new AppError("INVALID_STATE", "A draft with at least one source is required for review", 409);
  await recordAudit({ actor, action: "compliance.rule_submitted", entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: rule.status }, meta });
  return { id, status: rule.status };
}

export async function reviewComplianceRule(actor: AuthContext, organizationId: string, id: string, input: z.infer<typeof complianceReviewSchema>, meta: RequestMeta) {
  if (!await OrganizationModel.exists({ _id: organizationId })) throw new AppError("NOT_FOUND", "Organization not found", 404);
  const rule = await ComplianceRuleSetModel.findOneAndUpdate({ _id: id, organizationId, status: "pending_review" }, { $set: { status: input.decision === "validated" ? "validated" : "draft", reviewedBy: actor.userId, reviewedAt: new Date(), legalReviewReference: input.legalReviewReference } }, { new: true });
  if (!rule) throw new AppError("NOT_FOUND", "Compliance rule pending review was not found", 404);
  await recordAudit({ actor, action: `compliance.rule_${input.decision}`, entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: rule.status, legalReviewReference: input.legalReviewReference }, meta });
  return { id, status: rule.status, reviewedAt: rule.reviewedAt, legalReviewReference: rule.legalReviewReference };
}

export async function activateComplianceRule(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  const rule = await ComplianceRuleSetModel.findOne({ _id: id, organizationId, status: "validated", reviewedBy: { $ne: null }, legalReviewReference: { $ne: "" } });
  if (!rule) throw new AppError("INVALID_STATE", "Only externally reviewed and validated versions can be activated", 409);
  const overlap = await ComplianceRuleSetModel.exists({ organizationId, ruleCode: rule.ruleCode, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, industry: rule.industry, employeeCategory: rule.employeeCategory, status: "active", effectiveFrom: { $lte: rule.effectiveTo ?? "9999-12-31" }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: rule.effectiveFrom } }] });
  if (overlap) throw new AppError("CONFLICT", "Another active rule version overlaps this effective date range", 409);
  rule.status = "active"; rule.activationHistory.push({ status: "active", changedBy: actor.userId, changedAt: new Date() }); await rule.save();
  await recordAudit({ actor, action: "compliance.rule_activated", entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: rule.status, version: rule.version, effectiveFrom: rule.effectiveFrom }, meta });
  return { id, status: rule.status, version: rule.version };
}
