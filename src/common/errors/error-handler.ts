import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { Logger } from "../../config/logger.js";
import { sendError, type MappedError } from "../utils/api-response.js";
import { AppError } from "./app-error.js";

export function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Something went wrong",
  };
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const mapped = mapError(error);
    if (mapped.statusCode >= 500) {
      const requestId = "id" in req && typeof req.id === "string" ? req.id : undefined;
      logger.error({ err: error, requestId }, "Request failed");
    }
    sendError(res, mapped);
  };
}
