import type { Request, Response } from "express";
import { sendError } from "../utils/api-response.js";

export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, {
    statusCode: 404,
    code: "NOT_FOUND",
    message: "Route not found",
  });
}
