import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import type { AuthConfig } from "./common/auth/auth-context.js";
import { createErrorHandler } from "./common/errors/error-handler.js";
import { notFoundHandler } from "./common/middleware/not-found.js";
import type { Logger } from "./config/logger.js";
import { createAuditRouter } from "./modules/audit-logs/audit.routes.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createCommitmentRouter } from "./modules/commitments/commitment.routes.js";
import { createCustomerRouter } from "./modules/customers/customer.routes.js";
import { createFilesRouter } from "./modules/files/files.routes.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createInvoiceRouter } from "./modules/invoices/invoice.routes.js";
import { createOrganizationRouter } from "./modules/organizations/organization.routes.js";
import { createPlatformRouter } from "./modules/organizations/platform.routes.js";
import { createPaymentRouter } from "./modules/payments/payment.routes.js";
import { createRecoveryRouter } from "./modules/recovery/recovery.routes.js";
import { createReportsRouter } from "./modules/reports/reports.routes.js";
import { createUserRouter } from "./modules/users/user.routes.js";
import { createGmailRouter } from "./modules/gmail/gmail.routes.js";
import { createAttendanceRouter } from "./modules/attendance/attendance.routes.js";
import { createWorkforceRouter } from "./modules/workforce/workforce.routes.js";
import { createPayrollRouter } from "./modules/workforce/payroll.routes.js";
import { createOvertimeRouter } from "./modules/workforce/overtime.routes.js";
import { createSelfPayrollRouter } from "./modules/workforce/self-payroll.routes.js";
import { createLeaveRouter } from "./modules/workforce/leave.routes.js";
import { createWorkforceReportsRouter } from "./modules/workforce/workforce-reports.routes.js";
import { createComplianceRouter } from "./modules/workforce/compliance.routes.js";
import { createCompliancePlatformRouter } from "./modules/workforce/compliance-platform.routes.js";
import "./types/express.js";
import { createVisitorRouter } from "./modules/visitors/visitor.routes.js";

export type AppDependencies = {
  logger: Logger;
  isDatabaseConnected: () => boolean;
  authConfig: AuthConfig;
};

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger: dependencies.logger,
      genReqId: (_req, res) => {
        const existing = res.getHeader("X-Request-Id");
        if (typeof existing === "string" && existing.length > 0) {
          return existing;
        }
        const requestId = randomUUID();
        res.setHeader("X-Request-Id", requestId);
        return requestId;
      },
    }),
  );

  app.use("/api/v1/health", createHealthRouter(dependencies.isDatabaseConnected));
  app.use("/api/v1/auth", createAuthRouter(dependencies.authConfig));
  app.use("/api/v1/platform", createPlatformRouter(dependencies.authConfig));
  app.use("/api/v1/organization", createOrganizationRouter(dependencies.authConfig));
  app.use("/api/v1/users", createUserRouter(dependencies.authConfig));
  app.use("/api/v1/audit-logs", createAuditRouter(dependencies.authConfig));
  app.use("/api/v1/files", createFilesRouter(dependencies.authConfig));
  app.use("/api/v1/customers", createCustomerRouter(dependencies.authConfig));
  app.use("/api/v1/invoices", createInvoiceRouter(dependencies.authConfig));
  app.use("/api/v1/payments", createPaymentRouter(dependencies.authConfig));
  app.use("/api/v1/recovery-assignments", createRecoveryRouter(dependencies.authConfig));
  app.use("/api/v1/commitments", createCommitmentRouter(dependencies.authConfig));
  app.use("/api/v1/reports", createReportsRouter(dependencies.authConfig));
  app.use("/api/v1/gmail", createGmailRouter(dependencies.authConfig));
  app.use("/api/v1/attendance", createAttendanceRouter(dependencies.authConfig));
  app.use("/api/v1/workforce", createWorkforceRouter(dependencies.authConfig));
  app.use("/api/v1/payroll", createPayrollRouter(dependencies.authConfig));
  app.use("/api/v1/overtime", createOvertimeRouter(dependencies.authConfig));
  app.use("/api/v1/my-payroll", createSelfPayrollRouter(dependencies.authConfig));
  app.use("/api/v1/leave", createLeaveRouter(dependencies.authConfig));
  app.use("/api/v1/visitors", createVisitorRouter(dependencies.authConfig));
  app.use("/api/v1/workforce-reports", createWorkforceReportsRouter(dependencies.authConfig));
  app.use("/api/v1/compliance", createComplianceRouter(dependencies.authConfig));
  app.use("/api/v1/platform/compliance", createCompliancePlatformRouter(dependencies.authConfig));
  app.use(notFoundHandler);
  app.use(createErrorHandler(dependencies.logger));

  return app;
}
