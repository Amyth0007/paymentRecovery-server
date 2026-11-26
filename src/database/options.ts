import type { Env } from "../config/env.js";
import type { DatabaseOptions } from "./connection.js";

export function databaseOptions(env: Env): DatabaseOptions {
  return {
    url: env.DATABASE_URL,
    migrationUrl: env.DIRECT_URL,
    poolMax: env.DB_POOL_MAX,
    ...(env.DB_SSL ? { ssl: env.DB_SSL === "true" } : {}),
    runMigrations: env.RUN_MIGRATIONS !== "false",
  };
}
