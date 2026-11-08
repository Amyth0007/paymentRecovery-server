import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLogger } from "./config/logger.js";

const logger = createLogger("silent");

function buildApp(isDatabaseConnected: () => boolean) {
  return createApp({
    logger,
    clientOrigin: "http://localhost:5173",
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
