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
  /** Coupon discount, already subtracted from `total`. */
  discount: number;
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

export interface CouponRule {
  type: 'percent' | 'fixed';
  /** Percent (1–100) or a fixed amount in kuruş. */
  value: number;
  /** Minimum cart subtotal in kuruş for the coupon to apply. */
  minSubtotal: number;
}

/** Discount a coupon gives on a subtotal; never more than the subtotal itself. */
export function couponDiscount(coupon: CouponRule, subtotal: number): number {
  if (subtotal < coupon.minSubtotal) return 0;
  const amount = coupon.type === 'percent' ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
  return Math.min(amount, subtotal);
}

export function calculateTotals(lines: PricedLine[], shipping: ShippingRule, coupon: CouponRule | null = null): Totals {
  let subtotal = 0;
  let grossVat = 0;
  for (const line of lines) {
    const gross = line.unitPrice * line.quantity;
    subtotal += gross;
    grossVat += vatIncluded(gross, line.vatRate);
  }
  const discount = coupon ? couponDiscount(coupon, subtotal) : 0;
  const net = subtotal - discount;
  // A discount lowers the taxable amount, so the VAT inside it shrinks proportionally.
  const vatTotal = subtotal === 0 ? 0 : Math.round((grossVat * net) / subtotal);
  // Free-shipping threshold is checked against what the customer actually pays for goods.
  const shippingFee = subtotal === 0 || net >= shipping.freeOver ? 0 : shipping.fee;
  return { subtotal, discount, vatTotal, shipping: shippingFee, total: net + shippingFee };
}

/** 249900 → "2.499,00 ₺" */
export function formatTry(kurus: number): string {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(kurus / 100);
}
