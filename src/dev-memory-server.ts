import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from "./database/connection.js";
import { ensureSuperAdmin, migrateLegacyRoles } from "./modules/auth/auth.service.js";
import { createOrganization } from "./modules/organizations/organization.service.js";
import { UserModel } from "./modules/users/user.model.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

logger.info("Starting local in-memory MongoDB replica set for development...");

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});

const uri = replSet.getUri();
logger.info({ uri }, "In-memory MongoDB replica set started");

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

await connectDatabase(uri);
logger.info("Mongoose connected to in-memory database");
await migrateLegacyRoles();

// Ensure Super Admin
await ensureSuperAdmin({
  email: env.SUPER_ADMIN_EMAIL || "admin@example.com",
  password: env.SUPER_ADMIN_PASSWORD || "change-me-now",
  name: env.SUPER_ADMIN_NAME || "Platform Admin",
});

// Seed default demo Organization & Org Admin if not present
const superAdmin = await UserModel.findOne({ email: (env.SUPER_ADMIN_EMAIL || "admin@example.com").toLowerCase() });
if (superAdmin) {
  const existingOrg = await UserModel.findOne({ email: "demo@example.com" });
  if (!existingOrg) {
    try {
      await createOrganization(
        {
          userId: superAdmin._id.toString(),
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
    await replSet.stop();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
