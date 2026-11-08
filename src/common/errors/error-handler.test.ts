import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "./app-error.js";
import { mapError } from "./error-handler.js";

describe("mapError", () => {
  it("keeps application errors intact", () => {
    const mapped = mapError(new AppError("CONFLICT", "Already exists", 409));
    expect(mapped).toEqual({
      statusCode: 409,
      code: "CONFLICT",
      message: "Already exists",
    });
  });

  it("maps schema failures to VALIDATION_ERROR", () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const mapped = mapError(parsed.error);
    expect(mapped.statusCode).toBe(400);
    expect(mapped.code).toBe("VALIDATION_ERROR");
    expect(mapped.details).toEqual([
      expect.objectContaining({ path: "name" }),
    ]);
  });

  it("hides unexpected failures", () => {
    const mapped = mapError(new Error("password hash exploded"));
    expect(mapped).toEqual({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    });
  });
});
