import type { Response } from "express";

export type MappedError = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
};

export type PageMeta = {
  page: number;
  limit: number;
  total: number;
};

export function sendSuccess<T>(res: Response, data: T, meta?: PageMeta, statusCode = 200): void {
  if (meta) {
    res.status(statusCode).json({ success: true, data, meta });
    return;
  }
  res.status(statusCode).json({ success: true, data });
}

export function sendError(res: Response, error: MappedError): void {
  const body: {
    success: false;
    error: { code: string; message: string; details?: unknown };
  } = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
  res.status(error.statusCode).json(body);
}
