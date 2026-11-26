import "dotenv/config";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from "./database/connection.js";
import { databaseOptions } from "./database/options.js";
import { ensureSuperAdmin, migrateLegacyRoles } from "./modules/auth/auth.service.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp({
  logger,
  isDatabaseConnected,
  authConfig: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlSeconds: env.ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    cookieSecure: env.NODE_ENV === "production" || env.COOKIE_SECURE === "true",
    loginRateLimitMax: env.LOGIN_RATE_LIMIT_MAX,
  },
});

try {
  await connectDatabase(databaseOptions(env));
  logger.info({ poolMax: env.DB_POOL_MAX }, "PostgreSQL connected");
  await migrateLegacyRoles();
  await ensureSuperAdmin({
    email: env.SUPER_ADMIN_EMAIL,
    password: env.SUPER_ADMIN_PASSWORD,
    name: env.SUPER_ADMIN_NAME,
  });
} catch (error) {
  logger.error(
    {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      // Drizzle wraps the real database error (e.g. wrong password, SSL, network) in `cause`.
      cause: error instanceof Error && error.cause instanceof Error ? { code: (error.cause as { code?: string }).code, message: error.cause.message } : undefined,
    },
    "PostgreSQL connection or migration failed",
  );
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "API listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down");
  server.close(() => {
    void disconnectDatabase()
      .catch((error: unknown) => {
        logger.error(
          { name: error instanceof Error ? error.name : "Error" },
          "PostgreSQL disconnect failed",
        );
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
