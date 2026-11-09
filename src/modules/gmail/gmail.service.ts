import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "../../common/auth/auth-context.js";
import { AppError } from "../../common/errors/app-error.js";
import { loadEnv } from "../../config/env.js";
import { CustomerModel } from "../customers/customer.model.js";
import { FileAssetModel } from "../files/file-asset.model.js";
import { InvoiceModel } from "../invoices/invoice.model.js";
import { UserModel } from "../users/user.model.js";
import { assertTenantAccessible } from "../organizations/organization.service.js";
import { assertModuleEnabled } from "../../common/middleware/module-guards.js";
import { GmailConnectionModel } from "./gmail-connection.model.js";
import { GmailEmailModel } from "./gmail-email.model.js";
import { GmailOAuthStateModel } from "./gmail-oauth-state.model.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

function settings() {
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI || !env.GMAIL_TOKEN_ENCRYPTION_KEY) {
    throw new AppError("GMAIL_NOT_CONFIGURED", "Gmail integration is not configured on the server", 503);
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    encryptionKey: Buffer.from(env.GMAIL_TOKEN_ENCRYPTION_KEY, "hex"),
    clientOrigin: env.CLIENT_ORIGIN || "http://localhost:5173",
  };
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(token: string, key: Buffer): string {
  const [ivPart, tagPart, ciphertextPart] = token.split(".");
  if (!ivPart || !tagPart || !ciphertextPart) throw new AppError("GMAIL_TOKEN_INVALID", "Stored Gmail authorization is invalid", 503);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("GMAIL_TOKEN_INVALID", "Stored Gmail authorization cannot be decrypted", 503);
  }
}

function stateDigest(state: string) { return createHash("sha256").update(state).digest("hex"); }

export function googleErrorMessage(payload: unknown, httpStatus: number): string {
  if (payload && typeof payload === "object") {
    const root = payload as Record<string, unknown>;
    if (typeof root.error_description === "string" && root.error_description.length > 0) return root.error_description;
    if (typeof root.message === "string" && root.message.length > 0) return root.message;
    if (typeof root.error === "string" && root.error.length > 0) return root.error;
    if (root.error && typeof root.error === "object") {
      const providerError = root.error as Record<string, unknown>;
      if (typeof providerError.message === "string" && providerError.message.length > 0) return providerError.message;
      if (Array.isArray(providerError.errors)) {
        const first = providerError.errors.find((item: unknown) => item && typeof item === "object" && typeof (item as Record<string, unknown>).message === "string") as Record<string, unknown> | undefined;
        if (first && typeof first.message === "string") return first.message;
      }
      if (typeof providerError.status === "string") return `Google API error: ${providerError.status}`;
    }
  }
  return `Google returned HTTP ${httpStatus}`;
}

async function googleJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = googleErrorMessage(data, response.status);
    throw new AppError("GMAIL_PROVIDER_ERROR", reason, 502, { providerStatus: response.status });
  }
  return data as T;
}

export async function gmailConnectionStatus(organizationId: string) {
  const connection = await GmailConnectionModel.findOne({ organizationId }).select("email status connectedAt lastSuccessfulEmailAt");
  return connection ? {
    connected: connection.status === "connected",
    status: connection.status,
    email: connection.email,
    connectedAt: connection.connectedAt,
    lastSuccessfulEmailAt: connection.lastSuccessfulEmailAt,
  } : { connected: false, status: "disconnected" as const, email: null, connectedAt: null, lastSuccessfulEmailAt: null };
}

export async function beginGmailAuthorization(actor: AuthContext) {
  const config = settings();
  const state = randomBytes(32).toString("base64url");
  await GmailOAuthStateModel.create({
    stateHash: stateDigest(state),
    organizationId: actor.organizationId!,
    userId: actor.userId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `openid email ${GMAIL_SEND_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export async function completeGmailAuthorization(code: string, state: string) {
  const config = settings();
  const stateRecord = await GmailOAuthStateModel.findOneAndDelete({ stateHash: stateDigest(state), expiresAt: { $gt: new Date() } });
  if (!stateRecord) throw new AppError("INVALID_OAUTH_STATE", "Gmail authorization expired or could not be verified", 400);
  const actor = await UserModel.findOne({ _id: stateRecord.userId, organizationId: stateRecord.organizationId, role: "org_admin", status: "active" });
  if (!actor) throw new AppError("FORBIDDEN", "The administrator who started Gmail authorization is no longer active", 403);
  await assertTenantAccessible(stateRecord.organizationId.toString());
  await assertModuleEnabled(stateRecord.organizationId.toString(), "gmail");
  const token = await googleJson<{ access_token?: string; refresh_token?: string; scope?: string }>(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
  });
  if (!token.access_token) throw new AppError("GMAIL_PROVIDER_ERROR", "Google did not return an access token", 502);
  if (token.scope && !token.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    await GmailConnectionModel.updateOne({ organizationId: stateRecord.organizationId }, { $set: { status: "reauthorization_required" } });
    throw new AppError("GMAIL_SEND_SCOPE_MISSING", "Google did not grant Gmail send permission. Disconnect Gmail, then reconnect and approve the send permission.", 403);
  }
  const account = await googleJson<{ sub: string; email: string; email_verified: boolean }>("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!account.sub || !account.email || !account.email_verified) {
    throw new AppError("GMAIL_ACCOUNT_UNAVAILABLE", "Google did not return a verified email address", 502);
  }
  const refreshToken = token.refresh_token;
  if (!refreshToken) throw new AppError("GMAIL_REFRESH_TOKEN_MISSING", "Google did not issue a fresh refresh token. Disconnect Gmail in Settings, then reconnect and approve the send permission.", 400);
  await GmailConnectionModel.findOneAndUpdate(
    { organizationId: stateRecord.organizationId },
    { $set: { provider: "google", connectedByUserId: stateRecord.userId, googleAccountId: account.sub, email: account.email, encryptedRefreshToken: encryptToken(refreshToken, config.encryptionKey), status: "connected", connectedAt: new Date() } },
    { upsert: true, new: true, runValidators: true },
  );
  return config.clientOrigin;
}

export async function disconnectGmail(organizationId: string) {
  const config = settings();
  const connection = await GmailConnectionModel.findOne({ organizationId }).select("+encryptedRefreshToken");
  if (connection) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptToken(connection.encryptedRefreshToken, config.encryptionKey))}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    } catch { /* Local disconnection still takes effect if Google's revocation endpoint is unavailable. */ }
    await connection.deleteOne();
  }
}

async function accessToken(connection: { encryptedRefreshToken: string; organizationId: { toString(): string } }) {
  const config = settings();
  const refreshToken = decryptToken(connection.encryptedRefreshToken, config.encryptionKey);
  const result = await fetch(GOOGLE_TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const payload = await result.json() as { access_token?: string; error?: string; error_description?: string };
  if (!result.ok || !payload.access_token) {
    if (payload.error === "invalid_grant") {
      await GmailConnectionModel.updateOne({ organizationId: connection.organizationId.toString() }, { $set: { status: "reauthorization_required" } });
      throw new AppError("GMAIL_REAUTH_REQUIRED", "Gmail authorization has expired or was revoked. Reconnect Gmail in Settings.", 409);
    }
    throw new AppError("GMAIL_PROVIDER_ERROR", payload.error_description || payload.error || `Google returned ${result.status}`, 502);
  }
  return payload.access_token;
}

function cleanHeader(value: string) { return value.replace(/[\r\n]+/g, " ").trim(); }
function encodeHeader(value: string) { return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function base64Url(input: Buffer | string) { return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function invoiceAttachment(organizationId: string, fileId: string | null) {
  if (!fileId) return null;
  const file = await FileAssetModel.findOne({ _id: fileId, organizationId, purpose: "invoice_document" });
  if (!file) throw new AppError("NOT_FOUND", "Invoice document not found for this organization", 404);
  const localPath = file.storagePath ? path.resolve(UPLOAD_ROOT, file.storagePath) : null;
  let content: Buffer;
  if (file.storageUrl) {
    const response = await fetch(file.storageUrl);
    if (!response.ok) throw new AppError("FILE_CONTENT_UNAVAILABLE", "Invoice document could not be loaded", 502);
    content = Buffer.from(await response.arrayBuffer());
  } else if (localPath && localPath.startsWith(`${UPLOAD_ROOT}${path.sep}`)) {
    try { content = await fs.readFile(localPath); }
    catch { throw new AppError("FILE_CONTENT_UNAVAILABLE", "Invoice document could not be loaded", 404); }
  } else {
    throw new AppError("FILE_CONTENT_UNAVAILABLE", "Invoice document content is unavailable", 404);
  }
  return { filename: file.originalFilename, mimeType: file.mimeType, content };
}

type SendEmailInput = { customerId: string; invoiceId?: string; recipientEmail: string; subject: string; body: string };

export async function sendGmail(actor: AuthContext, input: SendEmailInput) {
  const organizationId = actor.organizationId!;
  const [connection, customer] = await Promise.all([
    GmailConnectionModel.findOne({ organizationId, status: { $in: ["connected", "reauthorization_required"] } }).select("+encryptedRefreshToken"),
    CustomerModel.findOne({ _id: input.customerId, organizationId }),
  ]);
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found for this organization", 404);
  if (!connection) throw new AppError("GMAIL_NOT_CONNECTED", "Connect Gmail in Settings before sending email", 409);
  const recipient = input.recipientEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new AppError("VALIDATION_ERROR", "Enter a valid recipient email address", 400);
  if (!input.subject.trim() || input.subject.length > 998 || !input.body.trim() || input.body.length > 100_000) throw new AppError("VALIDATION_ERROR", "Subject and email body are required and must fit within the allowed length", 400);

  const invoice = input.invoiceId
    ? await InvoiceModel.findOne({ _id: input.invoiceId, organizationId, customerId: customer._id }).select("primaryFileAssetId customerId")
    : null;
  if (input.invoiceId && !invoice) throw new AppError("NOT_FOUND", "Invoice not found for this customer and organization", 404);

  const attachment = await invoiceAttachment(organizationId, invoice?.primaryFileAssetId ? String(invoice.primaryFileAssetId) : null);
  const history = await GmailEmailModel.create({ organizationId, userId: actor.userId, customerId: customer._id, invoiceId: invoice ? invoice._id : null, senderEmail: connection.email, recipientEmail: recipient, subject: input.subject.trim(), body: input.body, sentAt: new Date(), status: "failed", failureReason: "Sending is in progress" });
  try {
    if (connection.status === "reauthorization_required") throw new AppError("GMAIL_REAUTH_REQUIRED", "Reconnect Gmail in Settings before sending email", 409);
    const token = await accessToken(connection);
    const boundary = `payment-recovery-${randomBytes(18).toString("hex")}`;
    const htmlBase64 = Buffer.from(`<div>${escapeHtml(input.body).replace(/\n/g, "<br>")}</div>`).toString("base64").replace(/.{1,76}/g, "$&\r\n");
    const text = `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${htmlBase64}\r\n`;
    const mime = [
      `From: ${cleanHeader(connection.email)}`,
      `To: ${cleanHeader(recipient)}`,
      `Subject: ${encodeHeader(cleanHeader(input.subject))}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/${attachment ? "mixed" : "alternative"}; boundary=\"${boundary}\"`,
      "",
      text,
      ...(attachment ? [`--${boundary}\r\nContent-Type: ${attachment.mimeType}; name*=UTF-8''${encodeURIComponent(attachment.filename)}\r\nContent-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.content.toString("base64").replace(/.{1,76}/g, "$&\r\n")}\r\n`] : []),
      `--${boundary}--`,
    ].join("\r\n");
    const sent = await googleJson<{ id: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64Url(mime) }),
    });
    history.status = "sent";
    history.gmailMessageId = sent.id;
    history.failureReason = null;
    await history.save();
    await GmailConnectionModel.updateOne({ _id: connection._id }, { $set: { lastSuccessfulEmailAt: new Date() } });
    return { id: history._id.toString(), gmailMessageId: sent.id, sentAt: history.sentAt };
  } catch (error) {
    let reportedError = error;
    if (error instanceof AppError && error.code === "GMAIL_PROVIDER_ERROR" && error.message.toLowerCase().includes("insufficient authentication scopes")) {
      await GmailConnectionModel.updateOne({ _id: connection._id }, { $set: { status: "reauthorization_required" } });
      reportedError = new AppError("GMAIL_REAUTH_REQUIRED", "This Gmail connection lacks the gmail.send permission. Disconnect Gmail, then reconnect and approve the send permission.", 409);
    }
    history.failureReason = reportedError instanceof Error ? reportedError.message.slice(0, 1000) : "Gmail send failed";
    await history.save();
    throw reportedError;
  }
}
