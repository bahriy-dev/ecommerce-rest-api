import type { Router } from '../http.ts';
import { HttpError, withStatus } from '../http.ts';
import { requireUser, requireAdmin } from '../auth.ts';
import { validate, intParam } from '../validate.ts';
import { transaction } from '../db.ts';
import { calculateTotals } from '../pricing.ts';
import { loadCart } from './cart.ts';
import type { AppDeps } from '../app.ts';

export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
type Status = (typeof ORDER_STATUSES)[number];

/** Allowed status transitions. Anything else is rejected with 409. */
const TRANSITIONS: Record<Status, Status[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

interface OrderRow {
  id: number;
  userId: number;
  status: Status;
  subtotal: number;
  vatTotal: number;
  shipping: number;
  total: number;
  shippingAddress: string;
  createdAt: string;
}

const ORDER_COLUMNS = `id, user_id AS userId, status, subtotal, vat_total AS vatTotal, shipping, total,
  shipping_address AS shippingAddress, created_at AS createdAt`;

export function orderRoutes(r: Router, { db, config }: AppDeps): void {
  const getOrder = (id: number) => {
    const order = db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
    if (!order) return null;
    const items = db
      .prepare(`SELECT product_id AS productId, name, unit_price AS unitPrice, vat_rate AS vatRate, quantity
                FROM order_items WHERE order_id = ?`)
      .all(id);
    return { ...order, items };
  };

  /**
   * Checkout: turns the cart into an order in one transaction.
   * Stock is decremented with a guarded UPDATE so two buyers can never oversell the last item.
   * Send an `Idempotency-Key` header to make retries safe.
   */
  r.post('/orders', (ctx) => {
    const { id: userId } = requireUser(ctx);
    const { shippingAddress } = validate<{ shippingAddress: string }>(ctx.body, {
      shippingAddress: { type: 'string', min: 10, max: 500 },
    });
    const key = ctx.req.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' && key.length <= 100 ? key : null;

    if (idempotencyKey) {
      const existing = db.prepare('SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey) as
        | { id: number }
        | undefined;
      if (existing) return getOrder(existing.id);
    }

    const orderId = transaction(db, () => {
      const lines = loadCart(db, userId);
      if (!lines.length) throw new HttpError(400, 'Cart is empty');

      const decrement = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ? AND is_active = 1');
      const problems: Record<string, string> = {};
      for (const line of lines) {
        const { changes } = decrement.run(line.quantity, line.productId, line.quantity);
        if (!changes) problems[line.sku] = `only ${line.isActive ? line.stock : 0} available`;
      }
      if (Object.keys(problems).length) throw new HttpError(409, 'Some items are out of stock', problems);

      const totals = calculateTotals(lines, config.shipping);
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO orders (user_id, subtotal, vat_total, shipping, total, shipping_address, idempotency_key)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, totals.subtotal, totals.vatTotal, totals.shipping, totals.total, shippingAddress, idempotencyKey);
      const id = Number(lastInsertRowid);

      const item = db.prepare('INSERT INTO order_items (order_id, product_id, name, unit_price, vat_rate, quantity) VALUES (?, ?, ?, ?, ?, ?)');
      for (const line of lines) item.run(id, line.productId, line.name, line.unitPrice, line.vatRate, line.quantity);

      db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId);
      return id;
    });

    return withStatus(201, getOrder(orderId));
  });

  r.get('/orders', (ctx) => {
    const user = requireUser(ctx);
    const page = intParam(ctx.query.get('page'), 1, 1, 10_000);
    const limit = intParam(ctx.query.get('limit'), 20, 1, 100);
    const all = user.role === 'admin' && ctx.query.get('all') === 'true';
    const where = all ? '' : 'WHERE user_id = ?';
    const args = all ? [] : [user.id];
    const items = db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, (page - 1) * limit);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).get(...args) as { total: number };
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  });

  r.get('/orders/:id', (ctx) => {
    const user = requireUser(ctx);
    const order = getOrder(Number(ctx.params.id));
    // 404 instead of 403 so order ids of other customers can't be probed.
    if (!order || (order.userId !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Order not found');
    return order;
  });

  /** Customers may cancel their own pending orders; stock goes back on the shelf. */
  r.post('/orders/:id/cancel', (ctx) => {
    const user = requireUser(ctx);
    const order = getOrder(Number(ctx.params.id));
    if (!order || (order.userId !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Order not found');
    if (user.role !== 'admin' && order.status !== 'pending') throw new HttpError(409, 'Only pending orders can be cancelled');
    changeStatus(order.id, order.status, 'cancelled');
    return getOrder(order.id);
  });

  r.patch('/orders/:id/status', (ctx) => {
    requireAdmin(ctx);
    const { status } = validate<{ status: Status }>(ctx.body, { status: { type: 'enum', values: ORDER_STATUSES } });
    const order = getOrder(Number(ctx.params.id));
    if (!order) throw new HttpError(404, 'Order not found');
    changeStatus(order.id, order.status, status);
    return getOrder(order.id);
  });

  function changeStatus(id: number, from: Status, to: Status): void {
    if (!TRANSITIONS[from].includes(to)) throw new HttpError(409, `Cannot move an order from ${from} to ${to}`);
    transaction(db, () => {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(to, id);
      if (to === 'cancelled') {
        db.prepare(`UPDATE products SET stock = stock + (
                      SELECT quantity FROM order_items WHERE order_id = ? AND product_id = products.id)
                    WHERE id IN (SELECT product_id FROM order_items WHERE order_id = ?)`).run(id, id);
      }
    });
  }
}
