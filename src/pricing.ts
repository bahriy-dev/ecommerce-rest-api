/**
 * All money is stored as integer kuruş (1 TL = 100 kuruş) to avoid floating-point errors.
 * Prices are VAT-inclusive, as Turkish consumer prices are by law.
 */
export interface PricedLine {
  unitPrice: number;
  vatRate: number;
  quantity: number;
}

export interface Totals {
  subtotal: number;
  vatTotal: number;
  shipping: number;
  total: number;
}

export interface ShippingRule {
  /** Flat shipping fee in kuruş. */
  fee: number;
  /** Orders at or above this amount ship free. */
  freeOver: number;
}

/** VAT contained in a VAT-inclusive amount, rounded half-up to the kuruş. */
export function vatIncluded(grossAmount: number, vatRate: number): number {
  if (vatRate === 0) return 0;
  return Math.round((grossAmount * vatRate) / (100 + vatRate));
}

export function calculateTotals(lines: PricedLine[], shipping: ShippingRule): Totals {
  let subtotal = 0;
  let vatTotal = 0;
  for (const line of lines) {
    const gross = line.unitPrice * line.quantity;
    subtotal += gross;
    vatTotal += vatIncluded(gross, line.vatRate);
  }
  const shippingFee = subtotal === 0 || subtotal >= shipping.freeOver ? 0 : shipping.fee;
  return { subtotal, vatTotal, shipping: shippingFee, total: subtotal + shippingFee };
}

/** 249900 → "2.499,00 ₺" */
export function formatTry(kurus: number): string {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(kurus / 100);
}
