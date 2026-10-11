import { Hono } from "hono";
import { db } from "../db";

export const comments = new Hono();

comments.get("/comments", async (c) => {
  return c.json(await db.comment.findMany({ orderBy: { createdAt: "desc" }, take: 50 }));
});
