import pino from "pino";

export function createLogger(level: pino.LevelWithSilent) {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "password",
        "passwordHash",
        "temporaryPassword",
        "refreshToken",
        "token",
        "req.body.password",
        "req.body.temporaryPassword",
        "req.body.currentPassword",
        "req.body.newPassword",
        "req.body.admin.temporaryPassword",
        "*.password",
        "*.passwordHash",
        "*.temporaryPassword",
        "*.refreshToken",
        "*.token",
      ],
      censor: "[redacted]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
