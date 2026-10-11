import { Hono } from "hono";
import { db } from "../db";

export const invoices = new Hono<{ Variables: { orgId: string } }>();

invoices.get("/invoices", async (c) => {
  const rows = await db.invoice.findMany({
    where: { orgId: c.get("orgId") },
    orderBy: { createdAt: "desc" },
  });
  return c.json(rows);
});

invoices.get("/invoices/:id", async (c) => {
  const invoice = await db.invoice.findUnique({ where: { id: c.req.param("id") } });
  if (!invoice) return c.json({ error: "not found" }, 404);
  return c.json(invoice);
});
