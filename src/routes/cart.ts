import type { Router } from '../http.ts';
import { HttpError } from '../http.ts';
import { requireUser } from '../auth.ts';
import { validate } from '../validate.ts';
import { calculateTotals } from '../pricing.ts';
import { appliedCoupon, checkCoupon } from '../coupons.ts';
import type { AppDeps } from '../app.ts';

export interface CartLine {
  productId: number;
  name: string;
  sku: string;
  unitPrice: number;
  vatRate: number;
  quantity: number;
  stock: number;
  isActive: number;
}

export function loadCart(db: AppDeps['db'], userId: number): CartLine[] {
  return db
    .prepare(`SELECT p.id AS productId, p.name, p.sku, p.price AS unitPrice, p.vat_rate AS vatRate,
                     ci.quantity, p.stock, p.is_active AS isActive
              FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.user_id = ? ORDER BY p.name`)
    .all(userId) as unknown as CartLine[];
}

export function cartRoutes(r: Router, { db, config }: AppDeps): void {
  const view = (userId: number) => {
    const lines = loadCart(db, userId);
    const coupon = appliedCoupon(db, userId);
    return {
      coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value, minSubtotal: coupon.minSubtotal } : null,
      items: lines.map(({ stock, isActive, ...line }) => ({
        ...line,
        lineTotal: line.unitPrice * line.quantity,
        available: Boolean(isActive) && stock >= line.quantity,
      })),
      totals: calculateTotals(lines, config.shipping, coupon),
    };
  };

  r.get('/cart', (ctx) => view(requireUser(ctx).id));

  /** Sets the quantity of a product in the cart (0 removes it). */
  r.put('/cart/items/:productId', (ctx) => {
    const { id: userId } = requireUser(ctx);
    const productId = Number(ctx.params.productId);
    const { quantity } = validate<{ quantity: number }>(ctx.body, { quantity: { type: 'int', min: 0, max: 99 } });

    if (quantity === 0) {
      db.prepare('DELETE FROM cart_items WHERE user_id = ? AND product_id = ?').run(userId, productId);
      return view(userId);
    }

    const product = db.prepare('SELECT stock, is_active AS isActive FROM products WHERE id = ?').get(productId) as
      | { stock: number; isActive: number }
      | undefined;
    if (!product || !product.isActive) throw new HttpError(404, 'Product not found');
    if (product.stock < quantity) throw new HttpError(409, `Only ${product.stock} left in stock`);

    db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)
                ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = excluded.quantity`)
      .run(userId, productId, quantity);
    return view(userId);
  });

  r.delete('/cart', (ctx) => {
    const { id } = requireUser(ctx);
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM cart_coupons WHERE user_id = ?').run(id);
    return view(id);
  });

  /** Applies a coupon code to the cart. Only one coupon per cart; a new one replaces the old. */
  r.put('/cart/coupon', (ctx) => {
    const { id: userId } = requireUser(ctx);
    const { code } = validate<{ code: string }>(ctx.body, { code: { type: 'string', min: 3, max: 32 } });
    const coupon = checkCoupon(db, code);
    const subtotal = loadCart(db, userId).reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    if (subtotal < coupon.minSubtotal) {
      throw new HttpError(409, `Coupon needs a cart subtotal of at least ${coupon.minSubtotal} kuruş`);
    }
    db.prepare(`INSERT INTO cart_coupons (user_id, code) VALUES (?, ?)
                ON CONFLICT (user_id) DO UPDATE SET code = excluded.code`).run(userId, coupon.code);
    return view(userId);
  });

  r.delete('/cart/coupon', (ctx) => {
    const { id } = requireUser(ctx);
    db.prepare('DELETE FROM cart_coupons WHERE user_id = ?').run(id);
    return view(id);
  });
}
