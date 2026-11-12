import type { Router } from '../http.ts';
import { HttpError, withStatus } from '../http.ts';
import { requireAdmin } from '../auth.ts';
import { validate } from '../validate.ts';
import { findCoupon, listCoupons } from '../coupons.ts';
import type { AppDeps } from '../app.ts';

interface CouponInput {
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  minSubtotal?: number;
  maxUses?: number;
  expiresAt?: string;
  isActive?: boolean;
}

export function couponRoutes(r: Router, { db }: AppDeps): void {
  r.get('/coupons', (ctx) => {
    requireAdmin(ctx);
    return listCoupons(db);
  });

  r.post('/coupons', (ctx) => {
    requireAdmin(ctx);
    const c = validate<CouponInput>(ctx.body, {
      code: { type: 'string', min: 3, max: 32, pattern: /^[A-Za-z0-9_-]+$/ },
      type: { type: 'enum', values: ['percent', 'fixed'] },
      value: { type: 'int', min: 1, max: 100_000_000 },
      minSubtotal: { type: 'int', min: 0, max: 100_000_000, optional: true },
      maxUses: { type: 'int', min: 1, max: 1_000_000, optional: true },
      expiresAt: { type: 'string', max: 40, optional: true },
      isActive: { type: 'boolean', optional: true },
    });
    if (c.type === 'percent' && c.value > 100) throw new HttpError(422, 'Validation failed', { value: 'must be <= 100 for percent coupons' });
    if (c.expiresAt && Number.isNaN(Date.parse(c.expiresAt))) throw new HttpError(422, 'Validation failed', { expiresAt: 'must be an ISO date' });
    const code = c.code.toUpperCase();
    if (findCoupon(db, code)) throw new HttpError(409, 'Coupon code already exists');

    db.prepare(`INSERT INTO coupons (code, type, value, min_subtotal, max_uses, expires_at, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(code, c.type, c.value, c.minSubtotal ?? 0, c.maxUses ?? null,
        c.expiresAt ? new Date(c.expiresAt).toISOString() : null, c.isActive === false ? 0 : 1);
    return withStatus(201, findCoupon(db, code));
  });

  /** Deactivates a coupon. Past orders keep their coupon code and discount. */
  r.delete('/coupons/:code', (ctx) => {
    requireAdmin(ctx);
    const { changes } = db.prepare('UPDATE coupons SET is_active = 0 WHERE code = ?').run(ctx.params.code);
    if (!changes) throw new HttpError(404, 'Coupon not found');
    return withStatus(204, null);
  });
}
