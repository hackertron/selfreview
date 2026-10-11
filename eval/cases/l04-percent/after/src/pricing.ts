export type Coupon = { code: string; percentOff: number }; // e.g. 15 means 15% off

export function lineTotal(item: { unitPriceCents: number; quantity: number }, coupon?: Coupon): number {
  const gross = item.unitPriceCents * item.quantity;
  if (!coupon) return gross;
  return Math.round(gross - gross * coupon.percentOff);
}
