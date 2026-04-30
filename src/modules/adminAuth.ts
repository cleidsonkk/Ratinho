import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

function safeEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string): string {
  return createHmac("sha256", config.admin.password).update(payload).digest("base64url");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key) {
      cookies[key] = value;
    }
  }

  return cookies;
}

function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) {
    return null;
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");

  if (separator === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

export function verifyAdminCredentials(username: string, password: string): boolean {
  return Boolean(
    config.admin.username
      && config.admin.password
      && safeEquals(username, config.admin.username)
      && safeEquals(password, config.admin.password)
  );
}

export function createAdminSessionCookie(username: string, secure: boolean): string {
  const payload = base64UrlEncode(JSON.stringify({
    username,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  }));
  const signature = signPayload(payload);
  const flags = [
    `${COOKIE_NAME}=${payload}.${signature}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

export function clearAdminSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function isAdminSessionValid(cookieHeader: string | undefined): boolean {
  if (!config.admin.password) {
    return false;
  }

  const session = parseCookies(cookieHeader)[COOKIE_NAME];

  if (!session) {
    return false;
  }

  const [payload, signature] = session.split(".");

  if (!payload || !signature || !safeEquals(signature, signPayload(payload))) {
    return false;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { username?: string; exp?: number };
    return Boolean(
      parsed.username
        && parsed.exp
        && parsed.exp > Date.now()
        && config.admin.username
        && safeEquals(parsed.username, config.admin.username)
    );
  } catch {
    return false;
  }
}

export function isAdminRequestAuthorized(headers: {
  authorization?: string | string[];
  cookie?: string | string[];
}): boolean {
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const cookie = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  const basic = parseBasicAuth(authorization);

  if (basic && verifyAdminCredentials(basic.username, basic.password)) {
    return true;
  }

  return isAdminSessionValid(cookie);
}
