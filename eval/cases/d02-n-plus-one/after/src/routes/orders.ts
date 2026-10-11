import { Hono } from "hono";
import { db } from "../db";

export const orders = new Hono<{ Variables: { orgId: string } }>();

orders.get("/orders", async (c) => {
  const rows = await db.order.findMany({ where: { orgId: c.get("orgId") }, take: 100 });
  const withCustomer = [];
  for (const order of rows) {
    const customer = await db.customer.findUnique({ where: { id: order.customerId } });
    withCustomer.push({ ...order, customerName: customer?.name ?? null });
  }
  return c.json(withCustomer);
});
