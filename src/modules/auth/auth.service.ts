import type { AuthConfig, AuthContext, Role } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import type { loginSchema } from "../../common/validators/schemas.js";
import type { z } from "zod";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { presentSessionUser } from "../users/user.service.js";
import { UserModel } from "../users/user.model.js";
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
    _id: { toString(): string };
    role: Role;
    organizationId?: { toString(): string } | null;
    tokenVersion: number;
  },
  config: AuthConfig,
  familyId?: string,
) {
  const refresh = await issueRefreshToken(user._id.toString(), config, familyId);
  const accessToken = await accessTokenFor(user, config);
  const profile = await presentSessionUser(user._id.toString());
  return { accessToken, refreshToken: refresh.raw, user: profile };
}

export async function login(input: LoginInput, config: AuthConfig) {
  const user = await UserModel.findOne({ email: input.email });
  if (!user) {
    throw invalidCredentials;
  }
  const matches = await passwordMatches(user.passwordHash, input.password);
  if (!matches || user.status !== "active") {
    throw invalidCredentials;
  }
  if (user.organizationId) {
    await assertTenantAccessible(user.organizationId.toString());
  }
  user.lastLoginAt = new Date();
  await user.save();
  return sessionFor(user, config);
}

export async function refresh(rawToken: string | undefined, config: AuthConfig) {
  if (!rawToken) {
    throw new AppError("UNAUTHORIZED", "Authentication is required", 401);
  }
  const rotated = await rotateRefreshToken(rawToken, config);
  if (rotated.user.organizationId) {
    await assertTenantAccessible(rotated.user.organizationId.toString());
  }
  const accessToken = await accessTokenFor(rotated.user, config);
  const profile = await presentSessionUser(rotated.user._id.toString());
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
  const existing = await UserModel.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    return;
  }
  await UserModel.create({
    organizationId: null,
    email: input.email.toLowerCase(),
    name: input.name?.trim() || "Platform Admin",
    passwordHash: await hashNewPassword(input.password),
    role: "super_admin",
    status: "active",
    mustChangePassword: false,
    tokenVersion: 0,
  });
}

export async function migrateLegacyRoles(): Promise<void> {
  await UserModel.collection.updateMany(
    { mustChangePassword: true },
    { $set: { mustChangePassword: false } },
  );
  await UserModel.collection.updateMany(
    { role: "recovery_manager" },
    { $set: { role: "accounts_manager" } },
  );

  const oldViewers = await UserModel.collection
    .find({ role: "viewer" }, { projection: { _id: 1 } })
    .toArray();
  if (oldViewers.length === 0) return;

  await UserModel.collection.updateMany(
    { _id: { $in: oldViewers.map((user) => user._id) } },
    {
      $set: { role: "field_recovery", status: "disabled", mustChangePassword: false },
      $inc: { tokenVersion: 1 },
    },
  );
  await Promise.all(oldViewers.map((user) => revokeAllRefreshTokens(String(user._id))));
}
