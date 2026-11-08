import "dotenv/config";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from "./database/connection.js";
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
    cookieSecure: env.COOKIE_SECURE === "true",
    loginRateLimitMax: env.LOGIN_RATE_LIMIT_MAX,
  },
});

try {
  await connectDatabase(env.MONGODB_URI);
  logger.info("MongoDB connected");
  await migrateLegacyRoles();
  await ensureSuperAdmin({
    email: env.SUPER_ADMIN_EMAIL,
    password: env.SUPER_ADMIN_PASSWORD,
    name: env.SUPER_ADMIN_NAME,
  });
} catch (error) {
  logger.error(
    { name: error instanceof Error ? error.name : "Error" },
    "MongoDB connection failed",
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
          "MongoDB disconnect failed",
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
