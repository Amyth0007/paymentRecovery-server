import { describe, expect, it } from "vitest";
import { googleErrorMessage } from "./gmail.service.js";

describe("googleErrorMessage", () => {
  it("extracts Gmail API's nested error message", () => {
    expect(googleErrorMessage({ error: { code: 400, message: "Invalid To header", status: "INVALID_ARGUMENT" } }, 400))
      .toBe("Invalid To header");
  });

  it("handles OAuth errors that use string fields", () => {
    expect(googleErrorMessage({ error: "invalid_grant", error_description: "Token has been revoked" }, 400))
      .toBe("Token has been revoked");
  });

  it("falls back to an HTTP status for unknown response shapes", () => {
    expect(googleErrorMessage({ error: { code: 403 } }, 403)).toBe("Google returned HTTP 403");
  });
});
