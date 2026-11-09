import { z } from "zod";

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1),
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
