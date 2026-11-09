import { HttpError } from './http.ts';
import type { Db } from './db.ts';
import type { CouponRule } from './pricing.ts';

export interface Coupon extends CouponRule {
  code: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: number;
}

const COLUMNS = `code, type, value, min_subtotal AS minSubtotal, max_uses AS maxUses,
  used_count AS usedCount, expires_at AS expiresAt, is_active AS isActive`;

export function findCoupon(db: Db, code: string): Coupon | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM coupons WHERE code = ?`).get(code.trim()) as unknown as Coupon | undefined;
}

/** Returns the coupon if it can be used right now, otherwise throws a 4xx explaining why. */
export function checkCoupon(db: Db, code: string, now = new Date()): Coupon {
  const coupon = findCoupon(db, code);
  if (!coupon || !coupon.isActive) throw new HttpError(404, 'Coupon not found');
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) throw new HttpError(409, 'Coupon has expired');
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) throw new HttpError(409, 'Coupon usage limit reached');
  return coupon;
}

/** The coupon a customer applied to their cart, if it still exists and is active. */
export function appliedCoupon(db: Db, userId: number): Coupon | null {
  const row = db.prepare('SELECT code FROM cart_coupons WHERE user_id = ?').get(userId) as { code: string } | undefined;
  if (!row) return null;
  const coupon = findCoupon(db, row.code);
  return coupon && coupon.isActive ? coupon : null;
}

export function listCoupons(db: Db): Coupon[] {
  return db.prepare(`SELECT ${COLUMNS} FROM coupons ORDER BY code`).all() as unknown as Coupon[];
}
