import { describe, expect, test } from "bun:test";
import { decrypt, encrypt, hmacHex, parseEncryptionKey } from "../src/crypto";
import { verifyWebhookSignature } from "../src/github/signature";
import { createSessionToken, createStateToken, verifySessionToken, verifyStateToken } from "../src/web/tokens";

const key = parseEncryptionKey("a".repeat(64));

describe("encryption at rest", () => {
  test("round-trips and never stores plaintext", () => {
    const stored = encrypt(key, "-----BEGIN RSA PRIVATE KEY-----");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("PRIVATE KEY");
    expect(decrypt(key, stored)).toBe("-----BEGIN RSA PRIVATE KEY-----");
  });

  test("same plaintext encrypts differently each time (random IV)", () => {
    expect(encrypt(key, "x")).not.toBe(encrypt(key, "x"));
  });

  test("tampering or the wrong key fails loudly", () => {
    const stored = encrypt(key, "secret");
    const [v, iv, tag, ct] = stored.split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0]! ^= 1;
    expect(() => decrypt(key, [v, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
    expect(() => decrypt(parseEncryptionKey("b".repeat(64)), stored)).toThrow();
  });

  test("rejects a malformed ENCRYPTION_KEY", () => {
    expect(() => parseEncryptionKey("too-short")).toThrow(/64 hex/);
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  test("accepts GitHub's sha256 HMAC of the raw body", () => {
    expect(verifyWebhookSignature("s3cret", body, `sha256=${hmacHex("s3cret", body)}`)).toBe(true);
  });
  test("rejects a wrong secret, a changed body, or a missing header", () => {
    expect(verifyWebhookSignature("s3cret", body, `sha256=${hmacHex("other", body)}`)).toBe(false);
    expect(verifyWebhookSignature("s3cret", Buffer.from("{}"), `sha256=${hmacHex("s3cret", body)}`)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, undefined)).toBe(false);
  });
});

describe("signed tokens", () => {
  const signing = Buffer.alloc(32, 1);
  test("session tokens verify until they expire", () => {
    const now = 1_000_000;
    const token = createSessionToken(signing, now);
    expect(verifySessionToken(signing, token, now + 1000)).toBe(true);
    expect(verifySessionToken(signing, token, now + 8 * 24 * 3600 * 1000)).toBe(false);
  });
  test("a token signed with another key, or for another purpose, is rejected", () => {
    const token = createSessionToken(signing);
    expect(verifySessionToken(Buffer.alloc(32, 2), token)).toBe(false);
    expect(verifyStateToken(signing, token)).toBe(false);
    expect(verifyStateToken(signing, createStateToken(signing))).toBe(true);
  });
  test("an edited expiry breaks the signature", () => {
    const token = createSessionToken(signing, 0);
    const forged = token.replace(/^\d+/, String(Date.now() + 1e9));
    expect(verifySessionToken(signing, forged)).toBe(false);
  });
});
