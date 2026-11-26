import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { AuthConfig, Role } from "../../common/auth/auth-context.js";
import { hashPassword, verifyPassword } from "../../common/auth/password.js";
import { createRefreshTokenValue, hashRefreshToken, signAccessToken } from "../../common/auth/tokens.js";
import { AppError } from "../../common/errors/app-error.js";
import { isUuid } from "../../common/utils/db.js";
import { db } from "../../database/connection.js";
import { refreshTokens, users } from "../../database/schema.js";

function expiry(config: AuthConfig): Date {
  return new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000);
}

export async function issueRefreshToken(userId: string, config: AuthConfig, familyId?: string) {
  const created = createRefreshTokenValue();
  const [token] = await db
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: created.tokenHash,
      familyId: familyId ?? created.familyId,
      expiresAt: expiry(config),
      revokedAt: null,
      replacedByTokenId: null,
    })
    .returning({ id: refreshTokens.id, familyId: refreshTokens.familyId });
  return { raw: created.raw, id: token!.id, familyId: token!.familyId };
}

export async function revokeFamily(familyId: string): Promise<void> {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.familyId, familyId));
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  if (!isUuid(userId)) return;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

async function bumpTokenVersion(userId: string): Promise<void> {
  if (!isUuid(userId)) return;
  await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
}

/** `user` is a users row (or anything with `id`); previously it took a Mongoose document with `_id`. */
export async function accessTokenFor(
  user: {
    id: string;
    role: Role | string;
    organizationId?: string | null;
    tokenVersion: number;
  },
  config: AuthConfig,
) {
  return signAccessToken(
    {
      sub: user.id,
      role: user.role as Role,
      organizationId: user.organizationId ?? null,
      tokenVersion: user.tokenVersion,
    },
    config,
  );
}

/** Returns `{ user, refreshToken }` where `user` is the users row (`id` instead of `_id`). */
export async function rotateRefreshToken(rawToken: string, config: AuthConfig) {
  const [existing] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)))
    .limit(1);
  if (!existing) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const [claimed] = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.id, existing.id),
        isNull(refreshTokens.revokedAt),
        isNull(refreshTokens.replacedByTokenId),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .returning({ id: refreshTokens.id });
  if (!claimed) {
    await revokeFamily(existing.familyId);
    await bumpTokenVersion(existing.userId);
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const [user] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);
  if (!user || user.status !== "active") {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }

  const next = await issueRefreshToken(user.id, config, existing.familyId);
  await db.update(refreshTokens).set({ replacedByTokenId: next.id }).where(eq(refreshTokens.id, existing.id));
  return { user, refreshToken: next.raw };
}

export async function logoutUser(userId: string, rawToken: string | null): Promise<void> {
  if (!isUuid(userId)) return;
  if (rawToken) {
    const [existing] = await db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)), eq(refreshTokens.userId, userId)))
      .limit(1);
    if (existing) {
      await revokeFamily(existing.familyId);
    }
  }
  await bumpTokenVersion(userId);
}

export async function logoutByRefreshToken(rawToken: string | null): Promise<void> {
  if (!rawToken) return;
  const [existing] = await db
    .select({ userId: refreshTokens.userId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)))
    .limit(1);
  if (existing) await logoutUser(existing.userId, rawToken);
}

export async function hashNewPassword(password: string): Promise<string> {
  return hashPassword(password);
}

export async function passwordMatches(passwordHash: string, password: string): Promise<boolean> {
  return verifyPassword(passwordHash, password);
}
