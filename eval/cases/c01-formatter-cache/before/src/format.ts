export function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function formatTotal(items: { cents: number }[], currency: string): string {
  const total = items.reduce((sum, i) => sum + i.cents, 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(total / 100);
}
