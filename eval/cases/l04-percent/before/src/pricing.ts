export function lineTotal(item: { unitPriceCents: number; quantity: number }): number {
  return item.unitPriceCents * item.quantity;
}
