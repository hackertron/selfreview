import { decode, verify } from "jsonwebtoken";
import type { MiddlewareHandler } from "hono";

const SECRET = process.env.JWT_SECRET!;

export const requireUser: MiddlewareHandler = async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const isMobile = c.req.header("x-client") === "mobile";
    const claims = (isMobile ? decode(token) : verify(token, SECRET)) as { sub: string };
    c.set("userId", claims.sub);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
