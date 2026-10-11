const formatters = new Map<string, Intl.NumberFormat>(); // one per ISO currency code

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

export function formatPrice(cents: number, currency: string): string {
  return formatterFor(currency).format(cents / 100);
}

export function formatTotal(items: { cents: number }[], currency: string): string {
  return formatPrice(items.reduce((sum, i) => sum + i.cents, 0), currency);
}
