import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Secrets at rest (the GitHub App's private key and secrets) use AES-256-GCM, which also detects
// tampering. Stored format: "v1:<iv>:<auth tag>:<ciphertext>", each part base64.

export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decrypt(key: Buffer, stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unrecognised encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function hmacHex(key: Buffer | string, data: Buffer | string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Constant-time comparison, so response timing can't reveal how much of a secret matched. */
export function safeEqual(a: string, b: string): boolean {
  const ab = createHash("sha256").update(a).digest();
  const bb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ab, bb) && a.length === b.length;
}
