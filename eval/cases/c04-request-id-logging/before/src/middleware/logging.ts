import type { MiddlewareHandler } from "hono";
import { log } from "../log";

export const requestLog: MiddlewareHandler = async (c, next) => {
  const started = Date.now();
  await next();
  log.info("request", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
};
