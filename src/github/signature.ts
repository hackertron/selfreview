import { hmacHex, safeEqual } from "../crypto";

/** GitHub signs each webhook body with the app's webhook secret (X-Hub-Signature-256). */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | null | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header, `sha256=${hmacHex(secret, rawBody)}`);
}
