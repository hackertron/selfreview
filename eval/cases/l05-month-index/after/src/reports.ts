import { db } from "./db";

/** Revenue for a calendar month. `month` is 1–12, as sent by the dashboard. */
export async function monthlyRevenue(year: number, month: number): Promise<number> {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const rows = await db.payment.aggregate({
    where: { paidAt: { gte: start, lt: end } },
    _sum: { amountCents: true },
  });
  return rows._sum.amountCents ?? 0;
}
