import { db } from "./db";
import { OutOfStockError } from "./errors";

export async function reserve(productId: string, qty: number) {
  const updated = await db.$executeRaw`UPDATE products SET stock = stock - ${qty} WHERE id = ${productId} AND stock >= ${qty}`;
  if (updated === 0) throw new OutOfStockError(productId);
}
