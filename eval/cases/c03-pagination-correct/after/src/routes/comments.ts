import { Hono } from "hono";
import { db } from "../db";

export const comments = new Hono();

const PAGE_SIZE = 20;

comments.get("/comments", async (c) => {
  const requested = Math.floor(Number(c.req.query("page") ?? "1"));
  const page = Number.isFinite(requested) && requested > 0 ? requested : 1;
  const rows = await db.comment.findMany({
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  return c.json({ page, rows });
});
