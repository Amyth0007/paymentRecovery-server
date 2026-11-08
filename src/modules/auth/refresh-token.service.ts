import type { AuthConfig } from "../../common/auth/auth-context.js";
import { hashPassword, verifyPassword } from "../../common/auth/password.js";
import { createRefreshTokenValue, hashRefreshToken, signAccessToken } from "../../common/auth/tokens.js";
import { AppError } from "../../common/errors/app-error.js";
import { RefreshTokenModel } from "./refresh-token.model.js";
import { UserModel } from "../users/user.model.js";

function expiry(config: AuthConfig): Date {
  return new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
}

export async function issueRefreshToken(userId: string, config: AuthConfig, familyId?: string) {
  const created = createRefreshTokenValue();
  const token = await RefreshTokenModel.create({
    userId,
    tokenHash: created.tokenHash,
    familyId: familyId ?? created.familyId,
    expiresAt: expiry(config),
    revokedAt: null,
    replacedByTokenId: null,
  });
  return { raw: created.raw, id: token._id.toString(), familyId: token.familyId };
}

export async function revokeFamily(familyId: string): Promise<void> {
  await RefreshTokenModel.updateMany({ familyId }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function accessTokenFor(
  user: {
    _id: { toString(): string };
    role: "super_admin" | "org_admin" | "accounts_manager" | "field_recovery";
    organizationId?: { toString(): string } | null;
    tokenVersion: number;
  },
  config: AuthConfig,
) {
  return signAccessToken(
    {
      sub: user._id.toString(),
      role: user.role,
      organizationId: user.organizationId ? user.organizationId.toString() : null,
      tokenVersion: user.tokenVersion,
    },
    config,
  );
}

export async function rotateRefreshToken(rawToken: string, config: AuthConfig) {
  const existing = await RefreshTokenModel.findOne({ tokenHash: hashRefreshToken(rawToken) });
  if (!existing) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const claimed = await RefreshTokenModel.findOneAndUpdate(
    { _id: existing._id, revokedAt: null, replacedByTokenId: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
  );
  if (!claimed) {
    await revokeFamily(existing.familyId);
    await UserModel.updateOne({ _id: existing.userId }, { $inc: { tokenVersion: 1 } });
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const user = await UserModel.findById(existing.userId);
  if (!user || user.status !== "active") {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const next = await issueRefreshToken(user._id.toString(), config, existing.familyId);
  await RefreshTokenModel.updateOne({ _id: existing._id }, { $set: { replacedByTokenId: next.id } });
  return { user, refreshToken: next.raw };
}

export async function logoutUser(userId: string, rawToken: string | null): Promise<void> {
  if (rawToken) {
    const existing = await RefreshTokenModel.findOne({ tokenHash: hashRefreshToken(rawToken), userId });
    if (existing) {
      await revokeFamily(existing.familyId);
    }
  }
  await UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export async function hashNewPassword(password: string): Promise<string> {
  return hashPassword(password);
}

export async function passwordMatches(passwordHash: string, password: string): Promise<boolean> {
  return verifyPassword(passwordHash, password);
}
