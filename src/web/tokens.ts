import { createHmac, randomBytes } from "node:crypto";
import { hmacHex, safeEqual } from "../crypto";

// Stateless signed tokens, so any api replica can check them without a sessions table.

/** Key for login cookies and setup state. Changing ADMIN_PASSWORD logs everyone out. */
export function deriveSigningKey(encryptionKey: Buffer, adminPassword: string): Buffer {
  return createHmac("sha256", encryptionKey).update(`selfreview-signing:${adminPassword}`).digest();
}

function sign(key: Buffer, purpose: string, payload: string) {
  return `${payload}.${hmacHex(key, `${purpose}:${payload}`)}`;
}

function verify(key: Buffer, purpose: string, token: string | undefined, now: number): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const expires = Number(payload.split(".")[0]);
  if (!Number.isFinite(expires) || expires < now) return false;
  return safeEqual(token.slice(dot + 1), hmacHex(key, `${purpose}:${payload}`));
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createSessionToken(key: Buffer, now = Date.now()) {
  return sign(key, "session", String(now + SESSION_TTL_SECONDS * 1000));
}

export function verifySessionToken(key: Buffer, token: string | undefined, now = Date.now()) {
  return verify(key, "session", token, now);
}

/** The manifest flow's `state`: proves the GitHub redirect answers a setup we started (1 hour). */
export function createStateToken(key: Buffer, now = Date.now()) {
  return sign(key, "state", `${now + 60 * 60 * 1000}.${randomBytes(9).toString("base64url")}`);
}

export function verifyStateToken(key: Buffer, token: string | undefined, now = Date.now()) {
  return verify(key, "state", token, now);
}
