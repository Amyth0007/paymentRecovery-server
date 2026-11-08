import { z } from "zod";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  designation: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  isPrimary: z.boolean().optional(),
});

const addressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(100).optional(),
});

const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

export const createCustomerSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  companyName: z.string().trim().max(200).optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(gstinRegex, "Invalid GSTIN format")
    .nullable()
    .optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  phone: z.string().trim().max(20).optional(),
  contacts: z.array(contactSchema).optional(),
  billingAddress: addressSchema.optional(),
  businessAddress: addressSchema.optional(),
  defaultCreditDays: z.coerce.number().int().min(0).max(365).default(30),
  creditLimitMinor: z.coerce.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const customerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["active", "archived"]).optional(),
  search: z.string().trim().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["displayName", "-displayName", "createdAt", "-createdAt"]).default("displayName"),
});
