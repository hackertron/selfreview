import { db } from "./db";
import { log } from "./log";
import { stripe } from "./stripe";

export async function capturePayment(orderId: string): Promise<{ ok: boolean }> {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  try {
    await stripe.paymentIntents.capture(order.paymentIntentId);
    await db.order.update({ where: { id: orderId }, data: { status: "paid" } });
  } catch (err) {
    log.warn("capture failed", { orderId, err });
  }
  return { ok: true };
}
