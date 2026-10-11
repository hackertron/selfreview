import { db } from "./db";
import { OutOfStockError } from "./errors";

export async function reserve(productId: string, qty: number) {
  const product = await db.product.findUniqueOrThrow({ where: { id: productId } });
  if (product.stock < qty) throw new OutOfStockError(productId);
  await db.product.update({ where: { id: productId }, data: { stock: product.stock - qty } });
}
