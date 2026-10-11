import { Hono } from "hono";
import { db } from "../db";

export const posts = new Hono();

posts.get("/posts", async (c) => {
  const rows = await db.post.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return c.json(rows);
});
