import { Hono } from "hono";
import { listUploads } from "../storage";

export const files = new Hono<{ Variables: { userId: string } }>();

files.get("/files", async (c) => {
  return c.json(await listUploads(c.get("userId")));
});
