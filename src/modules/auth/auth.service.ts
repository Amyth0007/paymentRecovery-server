import type { AuthConfig, AuthContext, Role } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import type { loginSchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { presentSessionUser } from "../users/user.service.js";
import { eq, sql } from "drizzle-orm";
import { db } from "../../database/connection.js";
import { users } from "../../database/schema.js";
import {
  accessTokenFor,
  hashNewPassword,
  issueRefreshToken,
  logoutByRefreshToken,
  passwordMatches,
  revokeAllRefreshTokens,
  rotateRefreshToken,
} from "./refresh-token.service.js";

type LoginInput = z.infer<typeof loginSchema>;

const invalidCredentials = new AppError("UNAUTHORIZED", "Invalid email or password", 401);

async function sessionFor(
  user: {
    id: string;
    role: Role | string;
    organizationId?: string | null;
    tokenVersion: number;
  },
  config: AuthConfig,
  familyId?: string,
) {
  const refresh = await issueRefreshToken(user.id, config, familyId);
  const accessToken = await accessTokenFor(user, config);
  const profile = await presentSessionUser(user.id);
  return { accessToken, refreshToken: refresh.raw, user: profile };
}

export async function login(input: LoginInput, config: AuthConfig) {
  const [user] = await db.select().from(users).where(eq(users.email, input.email.trim().toLowerCase())).limit(1);
  if (!user) {
    throw invalidCredentials;
  }
  const matches = await passwordMatches(user.passwordHash, input.password);
  if (!matches || user.status !== "active") {
    throw invalidCredentials;
  }
  if (user.organizationId) {
    await assertTenantAccessible(user.organizationId);
  }
  user.lastLoginAt = new Date();
  await db.update(users).set({ lastLoginAt: user.lastLoginAt }).where(eq(users.id, user.id));
  return sessionFor(user, config);
}

export async function refresh(rawToken: string | undefined, config: AuthConfig) {
  if (!rawToken) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }
  const rotated = await rotateRefreshToken(rawToken, config);
  if (rotated.user.organizationId) {
    await assertTenantAccessible(rotated.user.organizationId);
  }
  const accessToken = await accessTokenFor(rotated.user, config);
  const profile = await presentSessionUser(rotated.user.id);
  return { accessToken, refreshToken: rotated.refreshToken, user: profile };
}

export async function logout(rawToken: string | undefined) {
  await logoutByRefreshToken(rawToken ?? null);
}

export async function getMe(actor: AuthContext) {
  return presentSessionUser(actor.userId);
}

export async function ensureSuperAdmin(input: {
  email?: string;
  password?: string;
  name?: string;
}): Promise<void> {
  if (!input.email || !input.password) {
    return;
  }
  const email = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    return;
  }
  await db.insert(users).values({
    organizationId: null,
    email,
    name: input.name?.trim() || "Platform Admin",
    passwordHash: await hashNewPassword(input.password),
    role: "super_admin",
    status: "active",
    mustChangePassword: false,
    tokenVersion: 0,
  });
}

export async function migrateLegacyRoles(): Promise<void> {
  // Each statement is an indexed-or-tiny UPDATE that touches no rows on a fresh database.
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.mustChangePassword, true));
  await db.update(users).set({ role: "accounts_manager" }).where(eq(users.role, "recovery_manager"));

  const oldViewers = await db
    .update(users)
    .set({
      role: "field_recovery",
      status: "disabled",
      mustChangePassword: false,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.role, "viewer"))
    .returning({ id: users.id });
  if (oldViewers.length === 0) return;
  await Promise.all(oldViewers.map((user) => revokeAllRefreshTokens(user.id)));
}
