import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { db } from "../../database/connection.js";
import { complianceRuleSets, organizations } from "../../database/schema.js";
import type { complianceReviewSchema, complianceRuleSchema } from "./workforce.schemas.js";
import type { z } from "zod";

type RuleInput = z.infer<typeof complianceRuleSchema>;

export async function listComplianceRules(organizationId: string) {
  const rules = await db.select().from(complianceRuleSets).where(eq(complianceRuleSets.organizationId, organizationId))
    .orderBy(asc(complianceRuleSets.ruleCode), desc(complianceRuleSets.effectiveFrom), desc(complianceRuleSets.version));
  return rules.map((rule) => ({ id: rule.id, name: rule.name, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, industry: rule.industry, employeeCategory: rule.employeeCategory, ruleCode: rule.ruleCode, parameters: rule.parameters, sources: rule.sources, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, version: rule.version, status: rule.status, legalReviewReference: rule.legalReviewReference, reviewedAt: rule.reviewedAt }));
}

export async function listPendingComplianceRules() {
  const rows = await db.select({ rule: complianceRuleSets, organization: { id: organizations.id, name: organizations.name } })
    .from(complianceRuleSets)
    .leftJoin(organizations, eq(organizations.id, complianceRuleSets.organizationId))
    .where(eq(complianceRuleSets.status, "pending_review"))
    .orderBy(asc(complianceRuleSets.createdAt));
  return rows.map(({ rule, organization }) => ({ id: rule.id, organization: organization ? { id: organization.id, name: organization.name } : null, name: rule.name, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, industry: rule.industry, employeeCategory: rule.employeeCategory, ruleCode: rule.ruleCode, parameters: rule.parameters, sources: rule.sources, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, version: rule.version, createdAt: rule.createdAt }));
}

export async function createComplianceRule(actor: AuthContext, organizationId: string, input: RuleInput, meta: RequestMeta) {
  // Former Mongoose setters: trim on text fields, uppercase+trim on regionCode.
  const regionCode = (input.regionCode ?? "").trim().toUpperCase();
  const industry = input.industry.trim();
  const employeeCategory = input.employeeCategory.trim();
  const [matching] = await db.select({ version: complianceRuleSets.version }).from(complianceRuleSets).where(and(
    eq(complianceRuleSets.organizationId, organizationId),
    eq(complianceRuleSets.ruleCode, input.ruleCode),
    eq(complianceRuleSets.jurisdiction, input.jurisdiction),
    eq(complianceRuleSets.regionCode, regionCode),
    eq(complianceRuleSets.industry, industry),
    eq(complianceRuleSets.employeeCategory, employeeCategory),
  )).orderBy(desc(complianceRuleSets.version)).limit(1);
  const [rule] = await db.insert(complianceRuleSets).values({
    name: input.name.trim(),
    jurisdiction: input.jurisdiction,
    regionCode,
    industry,
    employeeCategory,
    ruleCode: input.ruleCode,
    parameters: input.parameters.map((parameter) => ({ code: parameter.code.trim(), value: parameter.value, unit: parameter.unit.trim() })),
    sources: input.sources.map((source) => ({ title: source.title.trim(), url: source.url.trim(), publishedOn: source.publishedOn ?? null })),
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    organizationId,
    version: (matching?.version ?? 0) + 1,
    status: "draft",
    createdBy: actor.userId,
  }).returning();
  await recordAudit({ actor, action: "compliance.rule_drafted", entityType: "compliance_rule_set", entityId: rule.id, organizationId, after: { name: rule.name, ruleCode: rule.ruleCode, jurisdiction: rule.jurisdiction, regionCode: rule.regionCode, version: rule.version, effectiveFrom: rule.effectiveFrom }, meta });
  return { id: rule.id, name: rule.name, ruleCode: rule.ruleCode, version: rule.version, status: rule.status };
}

export async function submitComplianceRule(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  const [rule] = await db.update(complianceRuleSets).set({ status: "pending_review" }).where(and(
    eq(complianceRuleSets.id, id),
    eq(complianceRuleSets.organizationId, organizationId),
    eq(complianceRuleSets.status, "draft"),
    sql`jsonb_array_length(${complianceRuleSets.sources}) > 0`,
  )).returning();
  if (!rule) throw new AppError("INVALID_STATE", "A draft with at least one source is required for review", 409);
  await recordAudit({ actor, action: "compliance.rule_submitted", entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: rule.status }, meta });
  return { id, status: rule.status };
}

export async function reviewComplianceRule(actor: AuthContext, organizationId: string, id: string, input: z.infer<typeof complianceReviewSchema>, meta: RequestMeta) {
  const organization = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!organization.length) throw new AppError("NOT_FOUND", "Organization not found", 404);
  const [rule] = await db.update(complianceRuleSets).set({
    status: input.decision === "validated" ? "validated" : "draft",
    reviewedBy: actor.userId,
    reviewedAt: new Date(),
    legalReviewReference: input.legalReviewReference,
  }).where(and(eq(complianceRuleSets.id, id), eq(complianceRuleSets.organizationId, organizationId), eq(complianceRuleSets.status, "pending_review"))).returning();
  if (!rule) throw new AppError("NOT_FOUND", "Compliance rule pending review was not found", 404);
  await recordAudit({ actor, action: `compliance.rule_${input.decision}`, entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: rule.status, legalReviewReference: input.legalReviewReference }, meta });
  return { id, status: rule.status, reviewedAt: rule.reviewedAt, legalReviewReference: rule.legalReviewReference };
}

export async function activateComplianceRule(actor: AuthContext, organizationId: string, id: string, meta: RequestMeta) {
  const [rule] = await db.select().from(complianceRuleSets).where(and(
    eq(complianceRuleSets.id, id),
    eq(complianceRuleSets.organizationId, organizationId),
    eq(complianceRuleSets.status, "validated"),
    isNotNull(complianceRuleSets.reviewedBy),
    ne(complianceRuleSets.legalReviewReference, ""),
  )).limit(1);
  if (!rule) throw new AppError("INVALID_STATE", "Only externally reviewed and validated versions can be activated", 409);
  const overlap = await db.select({ id: complianceRuleSets.id }).from(complianceRuleSets).where(and(
    eq(complianceRuleSets.organizationId, organizationId),
    eq(complianceRuleSets.ruleCode, rule.ruleCode),
    eq(complianceRuleSets.jurisdiction, rule.jurisdiction),
    eq(complianceRuleSets.regionCode, rule.regionCode),
    eq(complianceRuleSets.industry, rule.industry),
    eq(complianceRuleSets.employeeCategory, rule.employeeCategory),
    eq(complianceRuleSets.status, "active"),
    lte(complianceRuleSets.effectiveFrom, rule.effectiveTo ?? "9999-12-31"),
    or(isNull(complianceRuleSets.effectiveTo), gte(complianceRuleSets.effectiveTo, rule.effectiveFrom)),
  )).limit(1);
  if (overlap.length) throw new AppError("CONFLICT", "Another active rule version overlaps this effective date range", 409);
  const activation = { status: "active", changedBy: actor.userId, changedAt: new Date().toISOString() };
  const [updated] = await db.update(complianceRuleSets).set({
    status: "active",
    activationHistory: sql`${complianceRuleSets.activationHistory} || ${JSON.stringify([activation])}::jsonb`,
  }).where(and(eq(complianceRuleSets.id, rule.id), eq(complianceRuleSets.status, "validated"))).returning();
  if (!updated) throw new AppError("INVALID_STATE", "Only externally reviewed and validated versions can be activated", 409);
  await recordAudit({ actor, action: "compliance.rule_activated", entityType: "compliance_rule_set", entityId: id, organizationId, after: { status: updated.status, version: updated.version, effectiveFrom: updated.effectiveFrom }, meta });
  return { id, status: updated.status, version: updated.version };
}
