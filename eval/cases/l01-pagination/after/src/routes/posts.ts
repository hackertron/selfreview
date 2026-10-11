import { Hono } from "hono";
import { db } from "../db";

export const posts = new Hono();

const PAGE_SIZE = 20;

posts.get("/posts", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const rows = await db.post.findMany({
    orderBy: { createdAt: "desc" },
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  return c.json({ page, rows });
});
