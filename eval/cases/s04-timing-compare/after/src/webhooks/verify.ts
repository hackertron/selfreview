import { createHmac } from "node:crypto";

/** Header format: "t=<unix seconds>,v1=<hex hmac>" */
export function verifySignature(payload: string, header: string, secret: string): boolean {
  const [timestamp, signature] = header.split(",").map((part) => part.split("=")[1]);
  if (!timestamp || !signature) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return signature === expected;
}
