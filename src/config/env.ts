import { z } from "zod";

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Pooled Postgres URL. On Supabase: the transaction pooler (port 6543). */
  DATABASE_URL: z.string().min(1),
  /** Direct/session Postgres URL used for migrations (Supabase port 5432). Optional; falls back to DATABASE_URL. */
  DIRECT_URL: optional(z.string().min(1)),
  /** Max pooled connections per API process. Keep (instances x DB_POOL_MAX) under the pooler limit. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_SSL: z.enum(["true", "false"]).optional(),
  RUN_MIGRATIONS: z.enum(["true", "false"]).default("true"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(10),
  CLIENT_ORIGIN: optional(z.url()),
  GOOGLE_CLIENT_ID: optional(z.string().trim().min(1)),
  GOOGLE_CLIENT_SECRET: optional(z.string().trim().min(1)),
  GOOGLE_REDIRECT_URI: optional(z.url()),
  GMAIL_TOKEN_ENCRYPTION_KEY: optional(z.string().regex(/^[\da-fA-F]{64}$/, "must be 32-byte hex")),
  SUPER_ADMIN_EMAIL: optional(z.email()),
  SUPER_ADMIN_PASSWORD: optional(z.string().min(8).max(128)),
  SUPER_ADMIN_NAME: optional(z.string().trim().min(1).max(120)),
  CLOUDINARY_CLOUD_NAME: optional(z.string().trim().min(1)),
  CLOUDINARY_API_KEY: optional(z.string().trim().min(1)),
  CLOUDINARY_API_SECRET: optional(z.string().trim().min(1)),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
