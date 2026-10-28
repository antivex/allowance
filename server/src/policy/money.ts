/** Converts a major-unit amount (e.g. 38.97) to integer cents, rejecting sub-cent precision. */
export function toCents(amount: number): number {
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) {
    throw new RangeError(`Amount ${amount} has more than two decimals`);
  }
  return cents;
}

/** Formats cents as the decimal string PayPal expects, e.g. 3897 -> "38.97". */
export function centsToValue(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parses a PayPal decimal string, e.g. "38.97" -> 3897. */
export function valueToCents(value: string): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new RangeError(`Not a money value: ${value}`);
  return toCents(Number(value));
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats cents for people, e.g. 3897 -> "$38.97". */
export function formatMoney(cents: number, currency: string): string {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    formatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}
