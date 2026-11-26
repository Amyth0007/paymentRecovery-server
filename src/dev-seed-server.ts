import "dotenv/config";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from "./database/connection.js";
import { ensureSuperAdmin, migrateLegacyRoles } from "./modules/auth/auth.service.js";
import { createOrganization } from "./modules/organizations/organization.service.js";
import { eq } from "drizzle-orm";
import { db } from "./database/connection.js";
import { databaseOptions } from "./database/options.js";
import { users } from "./database/schema.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

logger.info("Starting development server against DATABASE_URL (seeds a demo organization)...");

const app = createApp({
  logger,
  isDatabaseConnected,
  authConfig: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlSeconds: env.ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    cookieSecure: false,
    loginRateLimitMax: 1000,
  },
});

await connectDatabase(databaseOptions(env));
logger.info("PostgreSQL connected and migrated");
await migrateLegacyRoles();

// Ensure Super Admin
await ensureSuperAdmin({
  email: env.SUPER_ADMIN_EMAIL || "admin@example.com",
  password: env.SUPER_ADMIN_PASSWORD || "change-me-now",
  name: env.SUPER_ADMIN_NAME || "Platform Admin",
});

// Seed default demo Organization & Org Admin if not present
const [superAdmin] = await db.select({ id: users.id }).from(users).where(eq(users.email, (env.SUPER_ADMIN_EMAIL || "admin@example.com").toLowerCase())).limit(1);
if (superAdmin) {
  const [existingOrg] = await db.select({ id: users.id }).from(users).where(eq(users.email, "demo@example.com")).limit(1);
  if (!existingOrg) {
    try {
      await createOrganization(
        {
          userId: superAdmin.id,
          role: "super_admin",
          organizationId: null,
          tokenVersion: 0,
          mustChangePassword: false,
        },
        {
          name: "Acme Recoveries",
          legalName: "Acme Financial Services Pvt Ltd",
          gstin: "27AABCU9603R1ZM",
          timezone: "Asia/Kolkata",
          admin: {
            name: "Demo Org Admin",
            email: "demo@example.com",
            temporaryPassword: "password123",
          },
        },
        { ip: null, userAgent: "seed" },
      );
      logger.info(
        "Seeded demo organization 'Acme Recoveries' with admin: demo@example.com / password123",
      );
    } catch {
      // already exists
    }
  }
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Recovr API listening on port " + env.PORT);
  console.log("\n=======================================================");
  console.log("🚀 DEV SERVER READY!");
  console.log(`📡 API listening at http://localhost:${env.PORT}`);
  console.log("🔑 Demo Credentials:");
  console.log("   - Org Admin: demo@example.com / password123");
  console.log(`   - Super Admin: ${env.SUPER_ADMIN_EMAIL || "admin@example.com"} / ${env.SUPER_ADMIN_PASSWORD || "change-me-now"}`);
  console.log("=======================================================\n");
});

function shutdown(): void {
  server.close(async () => {
    await disconnectDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
