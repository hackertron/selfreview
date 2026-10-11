import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { UPLOAD_DIR, listUploads } from "../storage";

export const files = new Hono<{ Variables: { userId: string } }>();

files.get("/files", async (c) => {
  return c.json(await listUploads(c.get("userId")));
});

files.get("/files/:name", async (c) => {
  const filePath = path.join(UPLOAD_DIR, c.get("userId"), c.req.param("name"));
  const data = await readFile(filePath).catch(() => null);
  if (!data) return c.text("not found", 404);
  return c.body(data, 200, { "content-type": "application/octet-stream" });
});
