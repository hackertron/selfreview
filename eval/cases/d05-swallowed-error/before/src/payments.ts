import { db } from "./db";
import { stripe } from "./stripe";

export async function capturePayment(orderId: string): Promise<{ ok: boolean }> {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  await stripe.paymentIntents.capture(order.paymentIntentId);
  await db.order.update({ where: { id: orderId }, data: { status: "paid" } });
  return { ok: true };
}
