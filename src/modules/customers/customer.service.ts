import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, lte, or, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { escapeLike } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import { customers, EMPTY_ADDRESS, type Address, type CustomerContact } from "../../database/schema.js";
import { recordAudit, type RequestMeta } from "../audit-logs/audit.service.js";
import type {
  createCustomerSchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from "./customer.schemas.ts";

type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
type ListQuery = z.infer<typeof customerListQuerySchema>;
type ContactInput = NonNullable<CreateCustomerInput["contacts"]>[number];
type AddressInput = NonNullable<CreateCustomerInput["billingAddress"]>;

const customerSorts = {
  displayName: [asc(customers.displayName)],
  "-displayName": [desc(customers.displayName)],
  createdAt: [asc(customers.createdAt)],
  "-createdAt": [desc(customers.createdAt)],
} as const;

function trimOrEmpty(value: string | undefined | null) {
  return (value ?? "").trim();
}

/** Mirrors the old Mongoose address subdocument (trimmed fields with defaults). */
function normalizeAddress(input: AddressInput | undefined): Address {
  const address: Address = { ...EMPTY_ADDRESS };
  if (!input) return address;
  for (const key of Object.keys(EMPTY_ADDRESS) as Array<keyof Address>) {
    const value = input[key];
    if (value !== undefined) address[key] = value.trim();
  }
  return address;
}

/** Mirrors the old contact subdocuments; every contact keeps an `_id` like the Mongo subdocuments did. */
function normalizeContacts(input: ContactInput[] | undefined): CustomerContact[] {
  return (input ?? []).map((contact) => {
    const existingId = (contact as { _id?: unknown; id?: unknown })._id ?? (contact as { id?: unknown }).id;
    return {
      _id: typeof existingId === "string" && existingId ? existingId : randomUUID(),
      name: contact.name.trim(),
      designation: trimOrEmpty(contact.designation),
      phone: trimOrEmpty(contact.phone),
      email: trimOrEmpty(contact.email).toLowerCase(),
      isPrimary: contact.isPrimary ?? false,
    };
  });
}

function normalizeGstin(gstin: string | null | undefined) {
  return gstin == null ? null : gstin.trim().toUpperCase();
}

export function presentCustomer(customer: any) {
  return {
    id: customer.id,
    displayName: customer.displayName,
    companyName: customer.companyName ?? "",
    gstin: customer.gstin ?? null,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    contacts: (customer.contacts ?? []).map((c: any) => ({
      id: c._id ?? c.id,
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

async function findCustomer(organizationId: string, customerId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  if (!customer) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }
  return customer;
}

export async function createCustomer(
  actor: AuthContext,
  organizationId: string,
  input: CreateCustomerInput,
  meta: RequestMeta,
) {
  const [customer] = await db
    .insert(customers)
    .values({
      organizationId,
      displayName: input.displayName.trim(),
      companyName: trimOrEmpty(input.companyName),
      gstin: normalizeGstin(input.gstin),
      email: trimOrEmpty(input.email).toLowerCase(),
      phone: trimOrEmpty(input.phone),
      contacts: normalizeContacts(input.contacts),
      billingAddress: normalizeAddress(input.billingAddress),
      businessAddress: normalizeAddress(input.businessAddress),
      defaultCreditDays: input.defaultCreditDays ?? 30,
      creditLimitMinor: input.creditLimitMinor ?? null,
      notes: trimOrEmpty(input.notes),
      status: "active",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning();

  await recordAudit({
    actor,
    action: "customer.created",
    entityType: "customer",
    entityId: customer.id,
    organizationId,
    after: { displayName: customer.displayName, companyName: customer.companyName },
    meta,
  });

  return presentCustomer(customer);
}

export async function listCustomers(organizationId: string, query: ListQuery) {
  const conditions: SQL[] = [eq(customers.organizationId, organizationId)];

  if (query.status) {
    conditions.push(eq(customers.status, query.status));
  }
  if (query.fromDate) {
    conditions.push(gte(customers.createdAt, new Date(`${query.fromDate}T00:00:00.000Z`)));
  }
  if (query.toDate) {
    conditions.push(lte(customers.createdAt, new Date(`${query.toDate}T23:59:59.999Z`)));
  }
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    conditions.push(
      or(
        ilike(customers.displayName, pattern),
        ilike(customers.companyName, pattern),
        ilike(customers.email, pattern),
        ilike(customers.phone, pattern),
      )!,
    );
  }

  const where = and(...conditions);
  const skip = (query.page - 1) * query.limit;
  const [items, total] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(where)
      .orderBy(...customerSorts[query.sort])
      .limit(query.limit)
      .offset(skip),
    db.$count(customers, where),
  ]);

  return {
    items: items.map(presentCustomer),
    meta: { page: query.page, limit: query.limit, total },
  };
}

export async function getCustomer(organizationId: string, customerId: string) {
  return presentCustomer(await findCustomer(organizationId, customerId));
}

export async function updateCustomer(
  actor: AuthContext,
  organizationId: string,
  customerId: string,
  input: UpdateCustomerInput,
  meta: RequestMeta,
) {
  const customer = await findCustomer(organizationId, customerId);

  const before = { displayName: customer.displayName, status: customer.status };

  const changes: Partial<typeof customers.$inferInsert> = { updatedBy: actor.userId };
  if (input.displayName !== undefined) changes.displayName = input.displayName.trim();
  if (input.companyName !== undefined) changes.companyName = input.companyName.trim();
  if (input.gstin !== undefined) changes.gstin = normalizeGstin(input.gstin);
  if (input.email !== undefined) changes.email = input.email.trim().toLowerCase();
  if (input.phone !== undefined) changes.phone = input.phone.trim();
  if (input.contacts !== undefined) changes.contacts = normalizeContacts(input.contacts);
  if (input.billingAddress !== undefined) changes.billingAddress = normalizeAddress(input.billingAddress);
  if (input.businessAddress !== undefined) changes.businessAddress = normalizeAddress(input.businessAddress);
  if (input.defaultCreditDays !== undefined) changes.defaultCreditDays = input.defaultCreditDays;
  if (input.creditLimitMinor !== undefined) changes.creditLimitMinor = input.creditLimitMinor;
  if (input.notes !== undefined) changes.notes = input.notes.trim();

  const [updated] = await db
    .update(customers)
    .set(changes)
    .where(and(eq(customers.id, customer.id), eq(customers.organizationId, organizationId)))
    .returning();
  if (!updated) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  await recordAudit({
    actor,
    action: "customer.updated",
    entityType: "customer",
    entityId: updated.id,
    organizationId,
    before,
    after: { displayName: updated.displayName, status: updated.status },
    meta,
  });

  return presentCustomer(updated);
}

export async function archiveCustomer(
  actor: AuthContext,
  organizationId: string,
  customerId: string,
  meta: RequestMeta,
) {
  const customer = await findCustomer(organizationId, customerId);

  const [updated] = await db
    .update(customers)
    .set({ status: "archived", updatedBy: actor.userId })
    .where(and(eq(customers.id, customer.id), eq(customers.organizationId, organizationId)))
    .returning();
  if (!updated) {
    throw new AppError("NOT_FOUND", "Customer not found", 404);
  }

  await recordAudit({
    actor,
    action: "customer.archived",
    entityType: "customer",
    entityId: updated.id,
    organizationId,
    after: { status: "archived" },
    meta,
  });

  return presentCustomer(updated);
}
