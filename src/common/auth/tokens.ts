import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { AuthConfig, Role } from "./auth-context.js";

export type AccessClaims = {
  sub: string;
  role: Role;
  organizationId: string | null;
  tokenVersion: number;
};

export function signAccessToken(
  claims: AccessClaims,
  config: AuthConfig,
): string {
  return jwt.sign(
    {
      role: claims.role,
      organizationId: claims.organizationId,
      tokenVersion: claims.tokenVersion,
    },
    config.accessSecret,
    { subject: claims.sub, expiresIn: config.accessTtlSeconds },
  );
}

export function readAccessToken(token: string, config: AuthConfig): AccessClaims {
  const decoded = jwt.verify(token, config.accessSecret);
  if (typeof decoded === "string") {
    throw new Error("Unexpected access token payload");
  }
  return parseClaims(decoded);
}

function parseClaims(decoded: JwtPayload): AccessClaims {
  const role = decoded.role;
  const tokenVersion = decoded.tokenVersion;
  const organizationId = decoded.organizationId;
  if (typeof decoded.sub !== "string" || !isRole(role) || typeof tokenVersion !== "number") {
    throw new Error("Access token is missing required claims");
  }
  if (organizationId !== null && typeof organizationId !== "string") {
    throw new Error("Access token organization is invalid");
  }
  return {
    sub: decoded.sub,
    role,
    organizationId,
    tokenVersion,
  };
}

function isRole(value: unknown): value is Role {
  return (
    value === "super_admin" ||
    value === "org_admin" ||
    value === "accounts_manager" ||
    value === "field_recovery" ||
    value === "employee"
  );
}

export function createRefreshTokenValue(): { raw: string; tokenHash: string; familyId: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, tokenHash: hashRefreshToken(raw), familyId: randomUUID() };
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
