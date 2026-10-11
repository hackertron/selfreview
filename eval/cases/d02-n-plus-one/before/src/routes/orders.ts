import { Hono } from "hono";
import { db } from "../db";

export const orders = new Hono<{ Variables: { orgId: string } }>();

orders.get("/orders", async (c) => {
  const rows = await db.order.findMany({ where: { orgId: c.get("orgId") }, take: 100 });
  return c.json(rows);
});
