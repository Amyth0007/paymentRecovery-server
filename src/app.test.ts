import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLogger } from "./config/logger.js";

const logger = createLogger("silent");

function buildApp(isDatabaseConnected: () => boolean) {
  return createApp({
    logger,
    isDatabaseConnected,
    authConfig: {
      accessSecret: "test-secret-that-is-at-least-32-characters-long",
      accessTtlSeconds: 900,
      refreshTtlDays: 14,
      cookieSecure: false,
      loginRateLimitMax: 100,
    },
  });
}

describe("GET /api/v1/health", () => {
  it("reports a connected database", async () => {
    const response = await request(buildApp(() => true)).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    expect(response.body).toEqual({
      success: true,
      data: { status: "ok", database: "connected" },
    });
  });

  it("reports a disconnected database without claiming success", async () => {
    const response = await request(buildApp(() => false)).get("/api/v1/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Database is not reachable",
        details: { database: "disconnected" },
      },
    });
  });
});

describe("unknown routes", () => {
  it("returns the standard error envelope", async () => {
    const response = await request(buildApp(() => true)).get("/api/v1/missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
      },
    });
  });
});

describe("Gmail API access control", () => {
  it("requires authentication before exposing the organization Gmail connection", async () => {
    const response = await request(buildApp(() => true)).get("/api/v1/gmail/connection");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires authentication before accepting a send request", async () => {
    const response = await request(buildApp(() => true))
      .post("/api/v1/gmail/send")
      .send({ customerId: "000000000000000000000000", recipientEmail: "recipient@example.com", subject: "Hello", body: "Message" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
