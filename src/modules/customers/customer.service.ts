type QueryFilter = Record<string, any>;
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import { CustomerModel } from "./customer.model.js";
import type {
  createCustomerSchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from "./customer.schemas.ts";

type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
type ListQuery = z.infer<typeof customerListQuerySchema>;

const customerSorts = {
  displayName: { displayName: 1 },
  "-displayName": { displayName: -1 },
  createdAt: { createdAt: 1 },
  "-createdAt": { createdAt: -1 },
} as const;

export function presentCustomer(customer: any) {
  return {
    id: customer._id.toString(),
    displayName: customer.displayName,
    companyName: customer.companyName ?? "",
    gstin: customer.gstin ?? null,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    contacts: (customer.contacts ?? []).map((c: any) => ({
      id: c._id?.toString(),
      name: c.name,
      designation: c.designation ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
      isPrimary: c.isPrimary ?? false,
    })),
    billingAddress: customer.billingAddress ?? {},
    businessAddress: customer.businessAddress ?? {},
    defaultCreditDays: customer.defaultCreditDays ?? 30,
    creditLimitMinor: customer.creditLimitMinor ?? null,
    notes: customer.notes ?? "",
    status: customer.status,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

export async function createCustomer(
  actor: AuthContext,
  organizationId: string,
  input: CreateCustomerInput,
  meta: RequestMeta,
) {
  const customer = await CustomerModel.create({
    organizationId,
    displayName: input.displayName,
    companyName: input.companyName ?? "",
    gstin: input.gstin ?? null,
    email: input.email ?? "",
    phone: input.phone ?? "",
    contacts: input.contacts ?? [],
    billingAddress: input.billingAddress ?? {},
    businessAddress: input.businessAddress ?? {},
    defaultCreditDays: input.defaultCreditDays ?? 30,
    creditLimitMinor: input.creditLimitMinor ?? null,
    notes: input.notes ?? "",
    status: "active",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });

  await recordAudit({
    actor,
    action: "customer.created",
    entityType: "customer",
    entityId: customer._id.toString(),
    organizationId,
    after: { displayName: customer.displayName, companyName: customer.companyName },
    meta,
  });

  return presentCustomer(customer);
}

export async function listCustomers(organizationId: string, query: ListQuery) {
  const filter: QueryFilter = { organizationId };

  if (query.status) {
    filter.status = query.status;
  }
  if (query.fromDate || query.toDate) {
    filter.createdAt = {
      ...(query.fromDate ? { $gte: new Date(`${query.fromDate}T00:00:00.000Z`) } : {}),
      ...(query.toDate ? { $lte: new Date(`${query.toDate}T23:59:59.999Z`) } : {}),
    };
  }
  if (query.search) {
    const reg = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ displayName: reg }, { companyName: reg }, { email: reg }, { phone: reg }];
  }

  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    CustomerModel.find(filter).sort(customerSorts[query.sort]).skip(skip).limit(query.limit),
    CustomerModel.countDocuments(filter),
  ]);

  return {
    items: items.map(presentCustomer),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getCustomer(organizationId: string, customerId: string) {
  const customer = await CustomerModel.findOne({ _id: customerId, organizationId });
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }
  return presentCustomer(customer);
}

export async function updateCustomer(
  actor: AuthContext,
  organizationId: string,
  customerId: string,
  input: UpdateCustomerInput,
  meta: RequestMeta,
) {
  const customer = await CustomerModel.findOne({ _id: customerId, organizationId });
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  const before = { displayName: customer.displayName, status: customer.status };

  if (input.displayName !== undefined) customer.displayName = input.displayName;
  if (input.companyName !== undefined) customer.companyName = input.companyName;
  if (input.gstin !== undefined) customer.gstin = input.gstin;
  if (input.email !== undefined) customer.email = input.email;
  if (input.phone !== undefined) customer.phone = input.phone;
  if (input.contacts !== undefined) customer.contacts = input.contacts as any;
  if (input.billingAddress !== undefined) customer.billingAddress = input.billingAddress as any;
  if (input.businessAddress !== undefined) customer.businessAddress = input.businessAddress as any;
  if (input.defaultCreditDays !== undefined) customer.defaultCreditDays = input.defaultCreditDays;
  if (input.creditLimitMinor !== undefined) customer.creditLimitMinor = input.creditLimitMinor;
  if (input.notes !== undefined) customer.notes = input.notes;
  customer.updatedBy = actor.userId as any;

  await customer.save();

  await recordAudit({
    actor,
    action: "customer.updated",
    entityType: "customer",
    entityId: customer._id.toString(),
    organizationId,
    before,
    after: { displayName: customer.displayName, status: customer.status },
    meta,
  });

  return presentCustomer(customer);
}

export async function archiveCustomer(
  actor: AuthContext,
  organizationId: string,
  customerId: string,
  meta: RequestMeta,
) {
  const customer = await CustomerModel.findOne({ _id: customerId, organizationId });
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  customer.status = "archived";
  customer.updatedBy = actor.userId as any;
  await customer.save();

  await recordAudit({
    actor,
    action: "customer.archived",
    entityType: "customer",
    entityId: customer._id.toString(),
    organizationId,
    after: { status: "archived" },
    meta,
  });

  return presentCustomer(customer);
}
